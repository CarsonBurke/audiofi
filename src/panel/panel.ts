// Side panel controller (SPEC §3.4, §10). Owns the player UI and audio playback;
// holds no model. Drives extraction on mount, renders the article, and turns
// transport actions into synthesis-control messages routed through the SW. The
// panel is a view that re-mounts when closed/reopened (§2), so durable state
// (article, settings, position) lives in chrome.storage, not in memory.

import { onMessage, post } from '../shared/messages';
import type { ExtractedArticle } from '../shared/types';
import { decodePcm } from '../shared/pcm';
import { VOICES, DEFAULT_VOICE, isKnownVoice } from '../shared/voices';
import { estimateListenSeconds } from '../content/chunk';
import { AudioPlayer, type QueuedChunk } from './player';
import { initTheme, cycleTheme, themeIcon } from './theme';
import { ICONS } from './icons';

function renderStaticIcons(): void {
  $('logo').innerHTML = ICONS.headphones;
  els.prev.innerHTML = ICONS.skipBack;
  els.next.innerHTML = ICONS.skipForward;
  els.stop.innerHTML = ICONS.stop;
  els.play.innerHTML = ICONS.play;
}

// Backpressure thresholds (chunks buffered-but-unplayed): pause the producer at
// HIGH, resume once it drains to LOW. Keeps a small look-ahead, bounds memory.
const HIGH_WATER = 3;
const LOW_WATER = 1;

const KEY_VOICE = 'settings.voice';
const KEY_SPEED = 'settings.speed';
const KEY_ARTICLE = 'session.article';
const KEY_POSITION = 'session.position';

type Mode = 'idle' | 'loading' | 'playing' | 'paused' | 'done' | 'error';

// ── DOM ──────────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const els = {
  banner: $<HTMLDivElement>('banner'),
  themeToggle: $<HTMLButtonElement>('theme-toggle'),
  header: $<HTMLElement>('reader-header'),
  title: $<HTMLHeadingElement>('title'),
  meta: $<HTMLParagraphElement>('meta'),
  progress: document.querySelector<HTMLElement>('[role="progressbar"]')!,
  progressFill: $<HTMLDivElement>('progress-fill'),
  controls: $<HTMLElement>('controls'),
  prev: $<HTMLButtonElement>('prev'),
  play: $<HTMLButtonElement>('play'),
  next: $<HTMLButtonElement>('next'),
  stop: $<HTMLButtonElement>('stop'),
  voice: $<HTMLSelectElement>('voice'),
  speed: $<HTMLInputElement>('speed'),
  speedOut: $<HTMLOutputElement>('speed-out'),
  body: $<HTMLElement>('body'),
  placeholder: $<HTMLDivElement>('placeholder'),
};

// ── State ────────────────────────────────────────────────────────────────────

let article: ExtractedArticle | null = null;
let blockEls: HTMLElement[] = [];
let currentBlock = 0;
let mode: Mode = 'idle';
let player: AudioPlayer | null = null;
let voice = DEFAULT_VOICE;
let speed = 1;

// Run epoch: bumped on every start/seek/stop and echoed by the offscreen on each
// chunk it emits, so late output from a superseded run is dropped (not played
// out of position). See SynthStart.epoch in the messaging protocol.
let epoch = 0;

// Producer flow control. `userPaused` reflects the play/pause button; the
// producer is told to pause when the user pauses OR the look-ahead buffer fills,
// and to resume only when neither holds. `producerPaused` is the last state we
// signalled (so we only message on change).
let userPaused = false;
let producerPaused = false;

// ── Boot ─────────────────────────────────────────────────────────────────────

void boot();

async function boot(): Promise<void> {
  renderStaticIcons();
  els.themeToggle.innerHTML = themeIcon(await initTheme());
  populateVoices();
  await loadSettings();
  await restoreSession();
  wireControls();
  listen();
  // Always (re)extract the active tab on mount; cheap and refreshes the view.
  post({ to: 'sw', type: 'EXTRACT_REQUEST' });
}

function populateVoices(): void {
  els.voice.innerHTML = '';
  for (const v of VOICES) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    els.voice.append(opt);
  }
}

async function loadSettings(): Promise<void> {
  const s = await chrome.storage.local.get([KEY_VOICE, KEY_SPEED]);
  voice = isKnownVoice(s[KEY_VOICE]) ? s[KEY_VOICE] : DEFAULT_VOICE;
  speed = typeof s[KEY_SPEED] === 'number' ? s[KEY_SPEED] : 1;
  els.voice.value = voice;
  els.speed.value = String(speed);
  els.speedOut.textContent = `${speed.toFixed(2)}×`;
}

async function restoreSession(): Promise<void> {
  const s = await chrome.storage.session.get([KEY_ARTICLE, KEY_POSITION]);
  if (s[KEY_ARTICLE]) {
    setArticle(s[KEY_ARTICLE] as ExtractedArticle);
    currentBlock = typeof s[KEY_POSITION] === 'number' ? s[KEY_POSITION] : 0;
    highlight(currentBlock, false);
    updateProgress();
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function setArticle(a: ExtractedArticle): void {
  article = a;
  els.title.textContent = a.title;
  const parts = [a.byline, a.siteName, listenTime(a)].filter(Boolean);
  els.meta.textContent = parts.join(' · ');

  els.body.innerHTML = '';
  blockEls = a.blocks.map((block, i) => {
    const el = document.createElement(block.kind === 'heading' ? 'h2' : 'p');
    el.className = `block ${block.kind}`;
    el.textContent = block.text;
    el.dataset.index = String(i);
    el.addEventListener('click', () => seekTo(i));
    els.body.append(el);
    return el;
  });

  els.header.hidden = false;
  els.controls.hidden = false;
  els.body.hidden = false;
  els.placeholder.hidden = true;
  setBanner(null);
  setMode('idle');
}

function listenTime(a: ExtractedArticle): string {
  const seconds = estimateListenSeconds(a.blocks);
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `~${minutes} min listen`;
}

function highlight(index: number, scroll = true): void {
  blockEls.forEach((el, i) => el.classList.toggle('active', i === index));
  if (scroll && blockEls[index]) {
    blockEls[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function updateProgress(): void {
  const total = blockEls.length;
  const pct = total <= 1 ? 0 : Math.round((currentBlock / (total - 1)) * 100);
  els.progressFill.style.width = `${pct}%`;
  els.progress.setAttribute('aria-valuenow', String(pct));
}

const BANNER_BASE = 'rounded-lg px-3 py-2.5 text-sm';
const BANNER_INFO =
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200';
const BANNER_ERROR =
  'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200';

function setBanner(text: string | null, isError = false): void {
  els.banner.hidden = text === null;
  els.banner.textContent = text ?? '';
  els.banner.className = `${BANNER_BASE} ${isError ? BANNER_ERROR : BANNER_INFO}`;
}

function setMode(next: Mode): void {
  mode = next;
  els.play.innerHTML = mode === 'playing' ? ICONS.pause : ICONS.play;
  els.play.setAttribute('aria-label', mode === 'playing' ? 'Pause' : 'Play');
  els.play.title = mode === 'playing' ? 'Pause' : 'Play';
  const hasArticle = article !== null;
  els.play.disabled = !hasArticle;
  els.prev.disabled = !hasArticle;
  els.next.disabled = !hasArticle;
  els.stop.disabled = !hasArticle || mode === 'idle';
}

// ── Controls ─────────────────────────────────────────────────────────────────

function wireControls(): void {
  els.themeToggle.addEventListener('click', async () => {
    els.themeToggle.innerHTML = themeIcon(await cycleTheme());
  });
  els.play.addEventListener('click', () => void togglePlay());
  els.stop.addEventListener('click', () => stop());
  els.prev.addEventListener('click', () => seekTo(currentBlock - 1));
  els.next.addEventListener('click', () => seekTo(currentBlock + 1));

  els.voice.addEventListener('change', () => {
    voice = els.voice.value;
    void chrome.storage.local.set({ [KEY_VOICE]: voice });
    if (isActive()) startSynthesis(currentBlock);
  });

  els.speed.addEventListener('input', () => {
    speed = Number(els.speed.value);
    els.speedOut.textContent = `${speed.toFixed(2)}×`;
  });
  els.speed.addEventListener('change', () => {
    void chrome.storage.local.set({ [KEY_SPEED]: speed });
    if (isActive()) startSynthesis(currentBlock);
  });

  // Keyboard: space toggles play unless focus is on a form control.
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isFormFocused()) {
      e.preventDefault();
      void togglePlay();
    }
  });
}

function isActive(): boolean {
  return mode === 'playing' || mode === 'paused' || mode === 'loading';
}

function isFormFocused(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON';
}

async function togglePlay(): Promise<void> {
  if (!article) return;
  if (mode === 'playing') {
    await player?.suspend();
    userPaused = true;
    syncBackpressure();
    setMode('paused');
    post({ to: 'sw', type: 'SESSION_STATE', phase: 'paused' });
    return;
  }
  if (mode === 'paused') {
    await player?.resume();
    userPaused = false;
    syncBackpressure();
    setMode('playing');
    post({ to: 'sw', type: 'SESSION_STATE', phase: 'playing' });
    return;
  }
  // idle / done / error → start from the top (done) or the current block.
  startSynthesis(mode === 'done' ? 0 : currentBlock);
}

function startSynthesis(fromBlock: number): void {
  if (!article) return;
  currentBlock = clamp(fromBlock);
  ensurePlayer();
  player!.flush();
  player!.setExpectMore(true);
  epoch += 1;
  userPaused = false;
  producerPaused = false;
  void player!.resume();
  highlight(currentBlock);
  updateProgress();
  setBanner('Preparing voice…');
  setMode('loading');
  post({
    to: 'sw',
    type: 'SYNTH_START',
    blocks: article.blocks,
    voice,
    speed,
    fromBlock: currentBlock,
    epoch,
    sink: 'panel',
  });
  post({ to: 'sw', type: 'SESSION_STATE', phase: 'synthesizing' });
}

function seekTo(target: number): void {
  if (!article) return;
  const block = clamp(target);
  if (isActive()) {
    currentBlock = block;
    ensurePlayer();
    player!.flush();
    player!.setExpectMore(true);
    epoch += 1;
    userPaused = false;
    producerPaused = false;
    void player!.resume();
    highlight(currentBlock);
    updateProgress();
    setMode('loading');
    post({ to: 'sw', type: 'SYNTH_SEEK', fromBlock: currentBlock, epoch });
  } else {
    // Not playing yet: just move the cursor.
    currentBlock = block;
    highlight(currentBlock);
    updateProgress();
    persistPosition();
  }
}

function stop(): void {
  post({ to: 'sw', type: 'SYNTH_STOP' });
  player?.flush();
  epoch += 1; // drop any chunk still in flight from the cancelled run
  userPaused = false;
  producerPaused = false;
  setMode('idle');
  setBanner(null);
  post({ to: 'sw', type: 'SESSION_STATE', phase: 'idle' });
}

/**
 * Reconcile the producer's pause state with the user's pause and the look-ahead
 * buffer, signalling the offscreen only when the desired state changes. A
 * hysteresis band (LOW_WATER..HIGH_WATER) prevents flapping.
 */
function syncBackpressure(): void {
  const ahead = player?.bufferedAhead ?? 0;
  let desired: boolean;
  if (userPaused || ahead >= HIGH_WATER) desired = true;
  else if (ahead <= LOW_WATER) desired = false;
  else desired = producerPaused; // stay put inside the band
  if (desired !== producerPaused) {
    producerPaused = desired;
    post({ to: 'sw', type: 'SYNTH_BACKPRESSURE', pause: desired });
  }
}

function ensurePlayer(): void {
  if (player) return;
  player = new AudioPlayer();
  player.onChunkStart = (chunk) => {
    currentBlock = chunk.blockIndex;
    if (mode === 'loading') setMode('playing');
    highlight(currentBlock);
    updateProgress();
    persistPosition();
  };
  player.onChunkEnd = () => {
    syncBackpressure();
  };
  player.onDrained = () => {
    setMode('done');
    setBanner('Finished.');
    post({ to: 'sw', type: 'SESSION_STATE', phase: 'idle' });
  };
}

// ── Incoming messages ────────────────────────────────────────────────────────

function listen(): void {
  onMessage('panel', (msg) => {
    switch (msg.type) {
      case 'EXTRACT_RESULT':
        setArticle(msg.article);
        currentBlock = 0;
        highlight(0, false);
        updateProgress();
        break;

      case 'EXTRACT_FAILED':
        if (!article) {
          els.placeholder.hidden = false;
          setBanner(extractFailureText(msg.reason), msg.reason === 'error');
        }
        break;

      case 'MODEL_STATUS':
        if (msg.state === 'loading') setBanner('Loading voice model…');
        else if (msg.state === 'ready') {
          setBanner(
            msg.backend === 'wasm' ? 'Using CPU mode (slower).' : null,
          );
        } else {
          setBanner(`Model error: ${msg.message ?? 'unknown'}`, true);
          setMode('error');
        }
        break;

      case 'MODEL_DOWNLOAD_PROGRESS':
        setBanner(`Downloading model… ${Math.round(msg.progress * 100)}%`);
        break;

      case 'SYNTH_PROGRESS':
        // While still buffering the first audio, surface synthesis progress.
        if (msg.epoch === epoch && mode === 'loading' && msg.total > 0) {
          setBanner(`Synthesizing… ${msg.done}/${msg.total}`);
        }
        break;

      case 'SYNTH_CHUNK':
        if (msg.epoch === epoch) handleChunk(msg);
        break;

      case 'SYNTH_DONE':
        if (msg.epoch === epoch) player?.setExpectMore(false);
        break;

      case 'ERROR':
        setBanner(`Error: ${msg.message}`, true);
        break;

      default:
        break;
    }
  });
}

function handleChunk(msg: Extract<import('../shared/messages').Message, { type: 'SYNTH_CHUNK' }>): void {
  if (!player) ensurePlayer();
  if (mode === 'loading') setBanner(null);

  const chunk: QueuedChunk = {
    index: msg.index,
    blockIndex: msg.blockIndex,
    kind: msg.kind,
    pcm: decodePcm(msg.pcm),
    sampleRate: msg.sampleRate,
    durationMs: msg.durationMs,
    text: msg.text,
  };
  player!.enqueue(chunk);
  syncBackpressure();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(index: number): number {
  return Math.min(Math.max(index, 0), Math.max(0, blockEls.length - 1));
}

function persistPosition(): void {
  void chrome.storage.session.set({ [KEY_POSITION]: currentBlock });
}

function extractFailureText(reason: 'not-article' | 'empty' | 'error'): string {
  switch (reason) {
    case 'not-article':
      return "This page doesn't look like an article.";
    case 'empty':
      return 'No readable text found on this page.';
    case 'error':
      return 'Extraction failed on this page.';
  }
}
