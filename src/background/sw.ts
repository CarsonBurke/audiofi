// Service worker (SPEC §3.2). A stateless router: it holds no model and does no
// inference (§12 — the SW is killed when idle and hard-capped at 5 min/task).
// Its jobs are (1) own the offscreen-document lifecycle, (2) bridge messages
// between content script ⇄ offscreen ⇄ side panel, (3) open the side panel, and
// (4) persist minimal session state so a restart can resume.

import { onMessage, post, type Message } from '../shared/messages';
import type { ExtractedArticle, SessionPhase, SessionMode } from '../shared/types';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

// chrome.storage.session keys. Audio never lands here — only small text state.
const KEY_ARTICLE = 'session.article';
const KEY_PHASE = 'session.phase';
const KEY_TAB = 'session.tabId';

// ── Side panel: open on toolbar click ────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Opening the panel on the action click is a user gesture Chrome allows
  // declaratively; the panel then drives extraction on mount.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[sw] setPanelBehavior failed:', err));
});

// Closing the tab a session belongs to ends that session: stop the engine, drop
// the sink (so draining output isn't relayed to a dead tab), and tell the
// surviving surface (the panel) to reset. Without this the offscreen would keep
// synthesizing into a sink that no longer exists.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId !== tabId && sinkTabId !== tabId) return;
  const ended = session;
  session = null;
  sinkTabId = null;
  post({ to: 'offscreen', type: 'SYNTH_STOP' });
  if (ended) {
    sendSync('panel', { ...ended, mode: 'idle', block: 0, total: 0, title: '' });
  }
});

// ── Offscreen document lifecycle ─────────────────────────────────────────────
//
// Created lazily on the first synthesis request — never at SW install/startup —
// to dodge the clients.matchAll() race (crbug.com/1451659) where a document
// created at startup isn't returned. A single in-flight creation promise guards
// against concurrent SYNTH_START messages racing createDocument().

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      // No ML/WebGPU reason exists in the enum; WORKERS is the documented host
      // for ONNX/WASM inference. The reason is a hint, not a WebGPU gate (§3.3).
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        'Run on-device neural text-to-speech (WebGPU/WASM) off the service-worker lifecycle.',
    })
    .catch((err) => {
      // Tolerate the benign "single document already exists" race.
      if (!String(err).includes('Only a single offscreen')) throw err;
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

// ── Session state helpers ────────────────────────────────────────────────────

async function setPhase(phase: SessionPhase): Promise<void> {
  await chrome.storage.session.set({ [KEY_PHASE]: phase });
}

async function resolveActiveTabId(
  sender: chrome.runtime.MessageSender,
): Promise<number | undefined> {
  if (sender.tab?.id !== undefined) return sender.tab.id;
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab?.id;
}

// ── Audio sink ───────────────────────────────────────────────────────────────
//
// Which surface receives this run's synthesized audio. For the in-page mini
// player the offscreen can't reach the content script directly (no chrome.tabs
// in an offscreen document), so it emits output to the SW, which relays it to
// the originating tab. Kept in memory; chunks arrive every few seconds and keep
// the SW warm, so it survives a normal playback session.
let sinkTabId: number | null = null;

const SYNTH_OUTPUT_TYPES = new Set([
  'SYNTH_CHUNK',
  'SYNTH_PROGRESS',
  'SYNTH_DONE',
  'MODEL_STATUS',
  'MODEL_DOWNLOAD_PROGRESS',
  'ERROR',
]);

// ── Shared playback session ──────────────────────────────────────────────────
//
// The side panel and the in-page widget are two views of one playback session.
// Audio plays only in the surface that started it (the *owner*, identified by the
// latest SYNTH_START — which also wins the offscreen engine via its runId); the
// other surface *follows*: it mirrors state and forwards its controls as
// TRANSPORT_INTENTs. The SW is the relay and the single arbiter of ownership.
interface LiveSession {
  tabId: number;
  owner: 'content' | 'panel';
  mode: SessionMode;
  block: number;
  total: number;
  title: string;
}
let session: LiveSession | null = null;

/** Deliver a SESSION_SYNC snapshot to one surface. The widget lives in the
 *  session's tab, so a 'content' delivery is bridged via that tab id. */
function sendSync(target: 'content' | 'panel', snap: LiveSession): void {
  const msg = {
    type: 'SESSION_SYNC' as const,
    owner: snap.owner,
    tabId: snap.tabId,
    mode: snap.mode,
    block: snap.block,
    total: snap.total,
    title: snap.title,
  };
  if (target === 'content') post({ ...msg, to: 'content' }, snap.tabId);
  else post({ ...msg, to: 'panel' });
}

/** Relay an owner's snapshot to the *follower* (the other surface). */
function relayToFollower(snap: LiveSession): void {
  sendSync(snap.owner === 'content' ? 'panel' : 'content', snap);
}

/**
 * Resolve which session tab a SESSION_SYNC / TRANSPORT_INTENT / SESSION_QUERY
 * refers to. The panel knows its loaded content tab and sends it in `msg.tabId`;
 * the in-page widget can't know its own tab id, so it sends the sentinel `-1` and
 * we authoritatively use the sender's tab. We disambiguate on the sentinel — not
 * on whether `sender.tab` exists — because that presence test is only incidentally
 * true (the production side panel has no sender tab, but a panel hosted in a tab,
 * as under CDP tests, does, which would otherwise mis-resolve to the panel's own
 * tab and drop every cross-surface message).
 */
function sessionTabOf(
  msgTabId: number | undefined,
  sender: chrome.runtime.MessageSender,
): number | undefined {
  return msgTabId !== undefined && msgTabId >= 0 ? msgTabId : sender.tab?.id;
}

// ── Cross-frame extraction ───────────────────────────────────────────────────
//
// An EXTRACT_REQUEST is broadcast to every frame in the tab (the content script
// runs with all_frames). The top frame is canonical: when it yields an article
// we use it immediately. Otherwise the article lives in a child frame — a
// paywall-bypass aggregator or reader proxy embeds it in a cross-origin iframe —
// so we keep the richest candidate any subframe returns and settle once the top
// frame has reported its verdict, with a short grace window for a slower or
// richer sibling. A hard cap guards against a tab with no responsive frame at
// all (e.g. a restricted page where no content script runs).
const GRACE_MS = 400;
const HARD_MS = 3000;

interface FrameCollect {
  /** Tab this collection is extracting, echoed to the panel so it can attribute
   *  a late settle to the right tab (and ignore a stale one). */
  tabId: number;
  best: { article: ExtractedArticle; score: number } | null;
  topVerdict: { reason: 'not-article' | 'empty' | 'error'; message?: string } | null;
  grace: ReturnType<typeof setTimeout> | null;
  hard: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

// One collection per tab being extracted, keyed by tab id. Keeping a map (rather
// than a single slot) lets panels in different browser windows extract their own
// active tabs concurrently without clobbering each other — each settles on its
// own timers and is attributed back to its tab.
const collects = new Map<number, FrameCollect>();

function articleScore(article: ExtractedArticle): number {
  let n = 0;
  for (const block of article.blocks) n += block.text.length;
  return n;
}

function clearCollect(c: FrameCollect): void {
  if (c.grace) clearTimeout(c.grace);
  if (c.hard) clearTimeout(c.hard);
}

/** Emit the winning candidate (or the top frame's failure) to the panel once. */
async function settleExtraction(tabId: number): Promise<void> {
  const c = collects.get(tabId);
  if (!c || c.settled) return;
  c.settled = true;
  clearCollect(c);
  collects.delete(tabId);
  const { best, topVerdict } = c;

  if (best) {
    await chrome.storage.session.set({ [KEY_ARTICLE]: best.article });
    await setPhase('idle');
    post({ to: 'panel', type: 'EXTRACT_RESULT', tabId, article: best.article });
  } else {
    await setPhase('error');
    post({
      to: 'panel',
      type: 'EXTRACT_FAILED',
      tabId,
      reason: topVerdict?.reason ?? 'not-article',
      message: topVerdict?.message,
    });
  }
}

// ── Message routing ──────────────────────────────────────────────────────────

// Serialize routing through a single promise chain so messages are forwarded in
// the exact order the panel sent them. Without this, an async handler (e.g.
// SYNTH_START awaiting ensureOffscreen) could be overtaken by a later
// synchronous one (SYNTH_STOP/SEEK), letting the offscreen start a run the user
// already cancelled — voiding its runId-based cancellation.
let routeChain: Promise<void> = Promise.resolve();

onMessage('sw', (msg, sender) => {
  routeChain = routeChain
    .then(() => route(msg, sender))
    .catch((err) => console.warn('[sw] route error:', err));
});

async function route(
  msg: Message,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  // Relay offscreen output to the in-page sink when one is active.
  if (SYNTH_OUTPUT_TYPES.has(msg.type)) {
    if (sinkTabId !== null) {
      post({ ...msg, to: 'content' } as Message, sinkTabId);
    }
    return;
  }

  switch (msg.type) {
    case 'EXTRACT_REQUEST': {
      const tabId = msg.tabId ?? (await resolveActiveTabId(sender));
      if (tabId === undefined) {
        post({ to: 'panel', type: 'EXTRACT_FAILED', tabId: -1, reason: 'error', message: 'No active tab.' });
        return;
      }
      await chrome.storage.session.set({ [KEY_TAB]: tabId });
      await setPhase('extracting');
      // Abandon any prior in-flight collection for this tab and begin a fresh one.
      const prior = collects.get(tabId);
      if (prior) clearCollect(prior);
      const c: FrameCollect = { tabId, best: null, topVerdict: null, grace: null, hard: null, settled: false };
      collects.set(tabId, c);
      c.hard = setTimeout(() => void settleExtraction(tabId), HARD_MS);
      // Broadcast to every frame in the tab (no frameId → all frames).
      post({ to: 'content', type: 'EXTRACT_REQUEST' }, tabId);
      return;
    }

    case 'EXTRACT_RESULT': {
      const article: ExtractedArticle = msg.article;
      // Replies carry the originating tab via the message sender.
      const tabId = sender.tab?.id;
      const collect = tabId !== undefined ? collects.get(tabId) : undefined;
      if (!collect || collect.settled) return; // stale/late reply — ignore
      // frameId 0 is the tab's top document; it wins outright when it has an
      // article, so the common single-frame case settles with no added latency.
      if (sender.frameId === 0) {
        collect.best = { article, score: articleScore(article) };
        await settleExtraction(collect.tabId);
        return;
      }
      const score = articleScore(article);
      if (!collect.best || score > collect.best.score) {
        collect.best = { article, score };
      }
      // A subframe candidate is only authoritative once the top frame has bowed
      // out; until then it may still be superseded by the top document. Open a
      // grace window so a richer sibling (or that top verdict) can arrive.
      if (collect.topVerdict && !collect.grace) {
        collect.grace = setTimeout(() => void settleExtraction(collect.tabId), GRACE_MS);
      }
      return;
    }

    case 'EXTRACT_PDF': {
      // The top frame is a PDF, not an article. Cancel the in-flight HTML
      // collection (so its timers don't later fire a spurious EXTRACT_FAILED)
      // and let the panel fetch + parse the bytes with pdf.js.
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        const collect = collects.get(tabId);
        if (collect) {
          clearCollect(collect);
          collect.settled = true;
          collects.delete(tabId);
        }
      }
      await setPhase('idle');
      post({ to: 'panel', type: 'EXTRACT_PDF', tabId: tabId ?? -1, url: msg.url });
      return;
    }

    case 'EXTRACT_FAILED': {
      // Only the top frame reports failure (subframes stay silent), so this is
      // the tab's baseline verdict. If no collection is active it's a stale
      // reply; surface it directly to avoid a hung panel.
      const tabId = sender.tab?.id;
      const collect = tabId !== undefined ? collects.get(tabId) : undefined;
      if (!collect || collect.settled) {
        await setPhase('error');
        post({
          to: 'panel',
          type: 'EXTRACT_FAILED',
          tabId: tabId ?? -1,
          reason: msg.reason,
          message: msg.message,
        });
        return;
      }
      collect.topVerdict = { reason: msg.reason, message: msg.message };
      // The top document has nothing. Give subframes a brief window to surface
      // an embedded article before declaring the page un-extractable.
      if (!collect.grace) {
        collect.grace = setTimeout(() => void settleExtraction(collect.tabId), GRACE_MS);
      }
      return;
    }

    case 'SYNTH_START': {
      // Record the sink: the originating tab for the in-page player, or the
      // panel (null tab → offscreen posts straight to the panel).
      sinkTabId = msg.sink === 'content' ? (sender.tab?.id ?? null) : null;
      // A SYNTH_START establishes ownership: this run wins the engine (runId++),
      // so it also wins the shared session (last START wins). If a *different*
      // surface owned the session, demote it to follower at once so it stops its
      // own audio. The owner's own SESSION_SYNC (sent right after start) fills in
      // title/progress and syncs a fresh follower.
      const owner: 'content' | 'panel' = msg.sink === 'content' ? 'content' : 'panel';
      const tabId = msg.tabId ?? sender.tab?.id;
      if (tabId !== undefined) {
        const prior = session;
        session = {
          tabId,
          owner,
          mode: 'loading',
          block: msg.fromBlock ?? 0,
          total: msg.blocks.length,
          title: prior && prior.tabId === tabId ? prior.title : '',
        };
        if (prior && (prior.owner !== owner || prior.tabId !== tabId)) {
          if (prior.tabId === tabId) {
            // Same tab, different surface: the prior owner becomes a follower of
            // this new session (its own SESSION_SYNC fills in title/progress).
            sendSync(prior.owner, session);
          } else {
            // Different tab: the single engine can serve only one session, so the
            // prior owner's session has ended. Tell it (addressed to *its* tab, via
            // the prior snapshot) the session is over, so it yields and leaves owner
            // state instead of becoming a zombie owner the engine no longer serves.
            sendSync(prior.owner, { ...prior, mode: 'idle', block: 0, total: 0, title: '' });
          }
        }
      }
      await ensureOffscreen();
      await setPhase('synthesizing');
      post({
        to: 'offscreen',
        type: 'SYNTH_START',
        blocks: msg.blocks,
        voice: msg.voice,
        speed: msg.speed,
        fromBlock: msg.fromBlock,
        epoch: msg.epoch,
        sink: msg.sink,
      });
      return;
    }

    case 'SYNTH_SEEK': {
      await ensureOffscreen();
      post({ to: 'offscreen', type: 'SYNTH_SEEK', fromBlock: msg.fromBlock, epoch: msg.epoch });
      return;
    }

    case 'SYNTH_STOP': {
      post({ to: 'offscreen', type: 'SYNTH_STOP' });
      // Drop the sink so any late, non-epoch-stamped output still draining from
      // the offscreen (MODEL_STATUS/ERROR, which the widget can't filter) isn't
      // relayed to a tab whose run has already ended.
      sinkTabId = null;
      // Tear the session down here too, authoritatively, rather than relying on the
      // owner's follow-up SESSION_SYNC(idle): if the owner surface is torn down
      // between this stop and that sync (panel closed, content navigated away), the
      // session would otherwise dangle and a rejoining surface would see a phantom.
      if (session) {
        const ended = session;
        session = null;
        relayToFollower(ended); // tell the follower the session ended
      }
      await setPhase('idle');
      return;
    }

    case 'SYNTH_BACKPRESSURE': {
      post({ to: 'offscreen', type: 'SYNTH_BACKPRESSURE', pause: msg.pause });
      return;
    }

    case 'SESSION_STATE': {
      await setPhase(msg.phase);
      return;
    }

    case 'SESSION_SYNC': {
      // The owner reporting its state. The widget (content) doesn't know its own
      // tab id, so the SW authoritatively derives it from the sender. Ignore a
      // stale report from a surface that no longer owns the session (a loser of a
      // simultaneous-start race) so it can't resurrect or hijack the session.
      const tabId = sessionTabOf(msg.tabId, sender);
      if (!session || msg.owner !== session.owner || tabId !== session.tabId) {
        return;
      }
      if (msg.mode === 'idle') {
        const ended = session;
        session = null;
        relayToFollower(ended); // tell the follower the session ended
        return;
      }
      session = {
        tabId,
        owner: msg.owner,
        mode: msg.mode,
        block: msg.block,
        total: msg.total,
        title: msg.title,
      };
      relayToFollower(session);
      return;
    }

    case 'TRANSPORT_INTENT': {
      // A follower's control. Route it to the owner, which executes it locally
      // (and then publishes the result). Drop if there's no session or it's for a
      // different tab (a stale follower from a tab we've since left).
      const tabId = sessionTabOf(msg.tabId, sender);
      if (!session || tabId !== session.tabId) return;
      post(
        { to: session.owner, type: 'TRANSPORT_INTENT', tabId: session.tabId, action: msg.action, block: msg.block },
        session.owner === 'content' ? session.tabId : undefined,
      );
      return;
    }

    case 'SESSION_QUERY': {
      // A surface (re)joining a tab asks for the live session so it can show
      // follower state immediately. Reply with the snapshot, or an idle marker so
      // it clears any stale follower UI. Content's tab id comes from the sender.
      const tabId = sessionTabOf(msg.tabId, sender);
      if (tabId === undefined) return; // no resolvable tab → nothing to report
      const snap: LiveSession =
        session && session.tabId === tabId
          ? session
          : { tabId, owner: msg.from, mode: 'idle', block: 0, total: 0, title: '' };
      sendSync(msg.from, snap);
      return;
    }

    default:
      // Messages addressed to other contexts never reach this handler.
      return;
  }
}
