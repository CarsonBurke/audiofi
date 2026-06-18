// Service worker (SPEC §3.2). A stateless router: it holds no model and does no
// inference (§12 — the SW is killed when idle and hard-capped at 5 min/task).
// Its jobs are (1) own the offscreen-document lifecycle, (2) bridge messages
// between content script ⇄ offscreen ⇄ side panel, (3) open the side panel, and
// (4) persist minimal session state so a restart can resume.

import { onMessage, post, type Message } from '../shared/messages';
import type { ExtractedArticle, SessionPhase } from '../shared/types';

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
        post({ to: 'panel', type: 'EXTRACT_FAILED', reason: 'error', message: 'No active tab.' });
        return;
      }
      await chrome.storage.session.set({ [KEY_TAB]: tabId });
      await setPhase('extracting');
      // Forward to the content script in the target tab.
      post({ to: 'content', type: 'EXTRACT_REQUEST' }, tabId);
      return;
    }

    case 'EXTRACT_RESULT': {
      const article: ExtractedArticle = msg.article;
      await chrome.storage.session.set({ [KEY_ARTICLE]: article });
      await setPhase('idle');
      post({ to: 'panel', type: 'EXTRACT_RESULT', article });
      return;
    }

    case 'EXTRACT_FAILED': {
      await setPhase('error');
      post({ to: 'panel', type: 'EXTRACT_FAILED', reason: msg.reason, message: msg.message });
      return;
    }

    case 'SYNTH_START': {
      // Record the sink: the originating tab for the in-page player, or the
      // panel (null tab → offscreen posts straight to the panel).
      sinkTabId = msg.sink === 'content' ? (sender.tab?.id ?? null) : null;
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

    default:
      // Messages addressed to other contexts never reach this handler.
      return;
  }
}
