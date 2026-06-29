// Typed messaging protocol shared across content script, service worker,
// offscreen document, and side panel. See SPEC §9.
//
// Transport model
// ---------------
// Every extension *page* context (SW, offscreen, side panel) talks over
// `chrome.runtime.sendMessage`, which fans the message out to every other page
// context. We therefore tag each message with a `to` channel and let each
// context ignore messages not addressed to it. Content scripts are the one
// exception: they are not reachable via `runtime.sendMessage`, so the service
// worker bridges to them with `chrome.tabs.sendMessage`.
//
// Audio payloads ride as base64-encoded PCM (see shared/pcm.ts). Extension
// messaging JSON-serialises payloads — a raw `Float32Array` does not survive the
// hop (it arrives as a plain, lengthless object) — so producers encode and
// consumers decode. Chunking (§6) keeps each encoded buffer small.

import type { Block, BlockKind, Backend, SessionPhase, SessionMode } from './types';
import type { TtsModelId } from './tts-models';

export type Channel = 'content' | 'sw' | 'offscreen' | 'panel';

interface Routed {
  /** Destination context. Senders set this; receivers filter on it. */
  to: Channel;
}

// ── Extraction ──────────────────────────────────────────────────────────────

export interface ExtractRequest extends Routed {
  type: 'EXTRACT_REQUEST';
  /** Tab to extract from. Resolved by the SW when omitted (active tab). */
  tabId?: number;
}

export interface ExtractResult extends Routed {
  type: 'EXTRACT_RESULT';
  /** The tab this result was extracted from, so the panel can attribute a late
   *  reply to the right tab after a rapid switch (and ignore a stale one). The
   *  SW stamps it when relaying to the panel; the content→SW hop omits it (the
   *  content script doesn't know its own tab id). */
  tabId?: number;
  article: import('./types').ExtractedArticle;
}

export interface ExtractFailed extends Routed {
  type: 'EXTRACT_FAILED';
  /** The tab this verdict is for (see {@link ExtractResult.tabId}). */
  tabId?: number;
  /** `not-article` when Readability declines; `error` on an unexpected throw. */
  reason: 'not-article' | 'empty' | 'error';
  message?: string;
}

export interface ExtractPdf extends Routed {
  type: 'EXTRACT_PDF';
  /** The PDF's URL (the top document's `location.href`). The content script
   *  reports this when it sees a `document.contentType === 'application/pdf'`
   *  page — the only MIME signal available, since the tabs API exposes none —
   *  so the panel can fetch + parse the bytes with pdf.js regardless of whether
   *  the URL ends in `.pdf`. The SW stamps {@link ExtractResult.tabId} when
   *  relaying to the panel; the content→SW hop omits it. */
  url: string;
  tabId?: number;
}

// ── Synthesis control (panel → offscreen) ────────────────────────────────────

export interface SynthStart extends Routed {
  type: 'SYNTH_START';
  blocks: Block[];
  model: TtsModelId;
  voice: string;
  speed: number;
  /** Begin synthesis at this source block (used by seek). Default 0. */
  fromBlock?: number;
  /**
   * Where synthesized audio should be delivered: the side panel, or the content
   * script's in-page mini-player. The offscreen routes all output of this run to
   * the sink; for 'content', the SW relays each message to the originating tab.
   */
  sink: 'panel' | 'content';
  /**
   * The tab this session reads. The panel sets it to the tab it's showing
   * (`loadedTabId`); the widget omits it and the SW falls back to the sender's
   * tab id. The SW records it as the shared session's tab so the *other* surface
   * can be kept in sync (see {@link SessionSync}).
   */
  tabId?: number;
  /**
   * Run epoch assigned by the panel. The offscreen stamps every chunk/progress/
   * done it emits with the epoch of the run that produced it, so the panel can
   * drop messages from a run that a later seek/stop has already superseded
   * (cancellation crosses an async message boundary the offscreen's local token
   * can't close on its own).
   */
  epoch: number;
}

export interface SynthSeek extends Routed {
  type: 'SYNTH_SEEK';
  fromBlock: number;
  epoch: number;
}

export interface SynthStop extends Routed {
  type: 'SYNTH_STOP';
}

export interface SynthBackpressure extends Routed {
  type: 'SYNTH_BACKPRESSURE';
  /** True → producer should pause; false → resume. */
  pause: boolean;
}

// ── Synthesis stream (offscreen → panel) ─────────────────────────────────────

export interface SynthChunk extends Routed {
  type: 'SYNTH_CHUNK';
  /** Run epoch this chunk belongs to (see SynthStart.epoch). */
  epoch: number;
  /** Monotonic index across the synthesis run. */
  index: number;
  blockIndex: number;
  kind: BlockKind;
  /**
   * Mono PCM samples in [-1, 1], base64-encoded (see shared/pcm.ts). Extension
   * messaging is JSON-serialised, so a raw Float32Array would not survive the
   * hop — producers call encodePcm() and consumers decodePcm().
   */
  pcm: string;
  sampleRate: number;
  durationMs: number;
  text: string;
}

export interface SynthProgress extends Routed {
  type: 'SYNTH_PROGRESS';
  epoch: number;
  done: number;
  total: number;
}

export interface SynthDone extends Routed {
  type: 'SYNTH_DONE';
  epoch: number;
  /** Index of the last chunk emitted, or -1 if nothing was produced. */
  lastIndex: number;
}

// ── Model lifecycle (offscreen → panel) ──────────────────────────────────────

export interface ModelStatus extends Routed {
  type: 'MODEL_STATUS';
  state: 'loading' | 'ready' | 'error';
  backend?: Backend;
  message?: string;
}

export interface ModelDownloadProgress extends Routed {
  type: 'MODEL_DOWNLOAD_PROGRESS';
  file: string;
  loaded: number;
  total: number;
  /** 0–1; transformers.js reports this directly. */
  progress: number;
}

// ── Session state + errors ───────────────────────────────────────────────────

export interface SessionState extends Routed {
  type: 'SESSION_STATE';
  phase: SessionPhase;
}

// ── Shared playback session (panel ⇄ widget sync) ────────────────────────────
//
// The side panel and the in-page widget are two views of one playback session.
// Audio stays with whichever surface *started* it (the "owner"); the other
// surface is a "follower" that mirrors state but plays no audio and forwards its
// controls as intents. The SW is the relay and holds the authoritative session.

export interface SessionSync extends Routed {
  type: 'SESSION_SYNC';
  /** Which surface owns (plays) the session. */
  owner: 'content' | 'panel';
  /** The tab the session reads; a follower ignores syncs for other tabs. */
  tabId: number;
  /** 'idle' means the session ended — followers return to their idle UI. */
  mode: SessionMode;
  /** Current block index (drives highlight + progress on the follower). */
  block: number;
  /** Total block count, so a follower with no article can still draw progress. */
  total: number;
  /** Article title, for a follower (e.g. a fresh widget) with no article yet. */
  title: string;
}

export interface TransportIntent extends Routed {
  type: 'TRANSPORT_INTENT';
  /** The session tab this intent targets; the SW drops a mismatched intent. */
  tabId: number;
  action: 'toggle' | 'seek' | 'stop';
  /** Target block for `seek`. */
  block?: number;
}

export interface SessionQuery extends Routed {
  type: 'SESSION_QUERY';
  /** The surface asking, so the SW addresses its reply (a {@link SessionSync}). */
  from: 'content' | 'panel';
  /** The tab the asker cares about (its own tab, or the panel's loaded tab). */
  tabId: number;
}

export interface ErrorMessage extends Routed {
  type: 'ERROR';
  code: string;
  message: string;
}

export type Message =
  | ExtractRequest
  | ExtractResult
  | ExtractFailed
  | ExtractPdf
  | SynthStart
  | SynthSeek
  | SynthStop
  | SynthBackpressure
  | SynthChunk
  | SynthProgress
  | SynthDone
  | ModelStatus
  | ModelDownloadProgress
  | SessionState
  | SessionSync
  | TransportIntent
  | SessionQuery
  | ErrorMessage;

export type MessageOfType<T extends Message['type']> = Extract<Message, { type: T }>;

// ── Transport helpers ────────────────────────────────────────────────────────

/**
 * Send a message to another context. Messages addressed to `content` require a
 * `tabId` and are delivered via `chrome.tabs.sendMessage` (the only path that
 * reaches a content script); everything else goes over `chrome.runtime`.
 */
export function post(msg: Message, tabId?: number): void {
  if (msg.to === 'content') {
    if (tabId === undefined) throw new Error('post(content) requires a tabId');
    void chrome.tabs.sendMessage(tabId, msg).catch(swallowDisconnect);
  } else {
    void chrome.runtime.sendMessage(msg).catch(swallowDisconnect);
  }
}

/**
 * Subscribe to messages addressed to `self`. Returns an unsubscribe function.
 * The handler may be async; its return value is ignored (we never keep the
 * `sendResponse` channel open — all replies are fresh `post()` calls).
 */
export function onMessage(
  self: Channel,
  handler: (msg: Message, sender: chrome.runtime.MessageSender) => void,
): () => void {
  const listener = (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
  ): void => {
    if (!isMessage(msg) || msg.to !== self) return;
    handler(msg, sender);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function isMessage(value: unknown): value is Message {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { to?: unknown }).to === 'string'
  );
}

/**
 * `sendMessage` rejects with "Could not establish connection / Receiving end
 * does not exist" when no context is listening (e.g. panel closed). That is an
 * expected, benign race for fire-and-forget routing — swallow it but re-throw
 * anything else.
 */
function swallowDisconnect(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection') ||
    message.includes('message port closed')
  ) {
    return;
  }
  console.warn('[messages] unexpected send failure:', message);
}
