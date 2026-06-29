// Side panel controller (SPEC §3.4, §10). Owns the player UI and audio playback;
// holds no model. Drives extraction on mount, renders the article, and turns
// transport actions into synthesis-control messages routed through the SW. The
// panel is a view that re-mounts when closed/reopened (§2), so durable state
// (article, settings, position) lives in chrome.storage, not in memory.

import { onMessage, post } from '../shared/messages';
import type { ExtractedArticle, SessionMode } from '../shared/types';
import { decodePcm } from '../shared/pcm';
import { VOICES, DEFAULT_VOICE, isKnownVoice } from '../shared/voices';
import {
  DEFAULT_TTS_MODEL,
  TTS_MODELS,
  isPlayableTtsModel,
  resolvePlayableTtsModel,
  ttsModelLabel,
  ttsModelPrototypeNote,
  ttsModelWarningNote,
  type TtsModelId,
} from '../shared/tts-models';
import { estimateListenSeconds } from '../content/chunk';
import { AudioPlayer, type QueuedChunk } from './player';
import { initTheme, cycleTheme, themeIcon } from './theme';
import { ICONS } from './icons';
import { Select, SELECT_STYLE } from '../ui/select';
import { SLIDER_STYLE } from '../ui/slider';
import { HoverSlider, HOVER_SLIDER_STYLE } from '../ui/hover-slider';
import {
  SPEED_MIN,
  SPEED_MAX,
  SPEED_STEP,
  SPEED_NOTCHES,
  speedToFraction,
  speedToValue,
  formatSpeed,
  clampSpeed,
} from '../ui/speed';
import {
  VOLUME_MIN,
  VOLUME_MAX,
  VOLUME_STEP,
  volumeToFraction,
  volumeToValue,
  formatVolume,
  volumeIcon,
  clampVolume,
} from '../ui/volume';

function renderStaticIcons(): void {
  $('logo').innerHTML = ICONS.headphones;
  els.prev.innerHTML = ICONS.skipBack;
  els.next.innerHTML = ICONS.skipForward;
  els.stop.innerHTML = ICONS.stop;
  els.play.innerHTML = ICONS.play;
  els.refresh.innerHTML = ICONS.refresh;
}

// Backpressure thresholds (chunks buffered-but-unplayed): pause the producer at
// HIGH, resume once it drains to LOW. Keeps a small look-ahead, bounds memory.
const HIGH_WATER = 3;
const LOW_WATER = 1;

const KEY_VOICE = 'settings.voice';
const KEY_MODEL = 'settings.model';
const KEY_SPEED = 'settings.speed';
const KEY_VOLUME = 'settings.volume';

// Per-tab memory: each tab's extracted article + reading position are cached so
// switching tabs (and returning) restores what you were reading. Stored under
// per-tab keys — not one shared object — so panels in different windows never
// clobber each other's writes; entries are dropped when their tab closes. The
// {url, article} record is written once; the small position writes frequently
// without rewriting the whole article.
const tabArtKey = (id: number): string => `session.tab.${id}`;
const tabPosKey = (id: number): string => `session.pos.${id}`;

interface TabArticle {
  url: string;
  article: ExtractedArticle;
}

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
  voiceSlot: $<HTMLDivElement>('voice-slot'),
  modelSelect: $<HTMLSelectElement>('model-select'),
  speedSlot: $<HTMLDivElement>('speed-slot'),
  volumeSlot: $<HTMLDivElement>('volume-slot'),
  body: $<HTMLElement>('body'),
  placeholder: $<HTMLDivElement>('placeholder'),
  refresh: $<HTMLButtonElement>('refresh'),
};

// Custom voice/speed/volume controls (shared with the in-page widget). Built in
// boot(). Speed and volume use the YouTube-style hover-reveal compact control.
let voiceSelect: Select;
let speedControl: HoverSlider;
let volumeControl: HoverSlider;

// ── State ────────────────────────────────────────────────────────────────────

let article: ExtractedArticle | null = null;
let blockEls: HTMLElement[] = [];
let currentBlock = 0;
let mode: Mode = 'idle';
let player: AudioPlayer | null = null;
let ttsModel: TtsModelId = DEFAULT_TTS_MODEL;
let voice = DEFAULT_VOICE;
let speed = 1;
let volume = 1;
// Level restored when the speaker icon is clicked to un-mute.
let lastVolume = 1;

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

// ── Active-tab following ─────────────────────────────────────────────────────
// The panel is one document per browser window; it follows its own window's
// active tab. `loadedTabId`/`loadedUrl` identify the tab whose article is on
// screen; `pendingExtract` attributes an in-flight extraction back to the tab
// that asked for it (a result can land after another switch); `tabDrift` records
// that the active tab moved away while audio is playing — we don't interrupt,
// we badge the refresh button instead (the badge's `has-update` class is the
// drift state). `followToken` guards async cache reads against a newer switch.
let myWindowId: number = chrome.windows.WINDOW_ID_NONE;
let loadedTabId: number | null = null;
let loadedUrl: string | null = null;
let pendingExtract: { tabId: number; url: string } | null = null;
let followToken = 0;

// ── Shared playback session (panel ⇄ widget) ─────────────────────────────────
// The panel and the in-page widget are two views of one session. Role:
//   'owner'    — this panel plays the audio; its controls act locally and it
//                publishes its state so the widget can mirror it.
//   'follower' — the widget owns audio; this panel mirrors (highlight/progress/
//                play button) and forwards its controls as TRANSPORT_INTENTs.
//   'idle'     — no session for the shown tab; controls start one (→ owner).
// `followerMode` holds the owner's mode while we follow (so the transport buttons
// reflect it without our local `mode`/`isActive()` thinking we play audio).
let sessionRole: 'idle' | 'owner' | 'follower' = 'idle';
let sessionTabId: number | null = null;
let followerMode: SessionMode | null = null;

// ── Boot ─────────────────────────────────────────────────────────────────────

void boot();

async function boot(): Promise<void> {
  renderStaticIcons();
  injectControlStyles();
  els.themeToggle.innerHTML = themeIcon(await initTheme());
  buildControls();
  await loadSettings();
  wireControls();
  listen();
  // Resolve our window, watch its tabs, then show whatever its active tab holds —
  // restoring a cached read or extracting fresh.
  myWindowId = (await chrome.windows.getCurrent()).id ?? chrome.windows.WINDOW_ID_NONE;
  watchTabs();
  const tab = await currentActiveTab();
  if (tab) await followTab(tab);
}

// The shared ui/ controls ship their CSS as strings (they target both the
// widget's shadow root and here); register them once on the panel document.
function injectControlStyles(): void {
  const style = document.createElement('style');
  style.textContent = SELECT_STYLE + SLIDER_STYLE + HOVER_SLIDER_STYLE;
  document.head.append(style);
}

function buildControls(): void {
  buildModelSelect();

  voiceSelect = new Select({
    options: VOICES.map((v) => ({ value: v.id, label: v.label })),
    value: voice,
    ariaLabel: 'Voice',
    onChange: (v) => {
      voice = v;
      void chrome.storage.local.set({ [KEY_VOICE]: v });
      if (isActive()) startSynthesis(currentBlock);
    },
  });
  els.voiceSlot.append(voiceSelect.el);

  speedControl = new HoverSlider({
    min: SPEED_MIN,
    max: SPEED_MAX,
    step: SPEED_STEP,
    value: speed,
    toFraction: speedToFraction,
    toValue: speedToValue,
    notches: SPEED_NOTCHES,
    format: formatSpeed,
    ariaLabel: 'Speech speed',
    triggerHtml: formatSpeed(speed),
    triggerAriaLabel: 'Speech speed',
    railHeight: 132,
    onInput: (v) => {
      speed = v;
      speedControl.setTrigger(formatSpeed(v));
    },
    onChange: (v) => {
      speed = v;
      speedControl.setTrigger(formatSpeed(v));
      void chrome.storage.local.set({ [KEY_SPEED]: v });
      if (isActive()) startSynthesis(currentBlock);
    },
  });
  els.speedSlot.append(speedControl.el);

  volumeControl = new HoverSlider({
    min: VOLUME_MIN,
    max: VOLUME_MAX,
    step: VOLUME_STEP,
    value: volume,
    toFraction: volumeToFraction,
    toValue: volumeToValue,
    notches: [],
    format: formatVolume,
    ariaLabel: 'Volume',
    triggerHtml: volumeIcon(volume),
    triggerAriaLabel: 'Mute',
    railHeight: 104,
    onTrigger: () => toggleMute(),
    onInput: (v) => applyVolume(v, false),
    onChange: (v) => applyVolume(v, true),
  });
  els.volumeSlot.append(volumeControl.el);
}

function buildModelSelect(): void {
  els.modelSelect.replaceChildren(
    ...TTS_MODELS.map((model) => {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.playable ? model.label : `${model.label} (prototype)`;
      opt.title = model.description;
      opt.disabled = !model.playable;
      return opt;
    }),
  );
  els.modelSelect.value = ttsModel;
  els.modelSelect.addEventListener('change', () => {
    ttsModel = resolvePlayableTtsModel(els.modelSelect.value);
    els.modelSelect.value = ttsModel;
    void chrome.storage.local.set({ [KEY_MODEL]: ttsModel });
    if (isActive()) stop();
    reflectModelAvailability();
  });
}

// Apply a volume level to the live player and the trigger glyph; optionally
// persist it. `lastVolume` tracks the last audible level for mute/un-mute.
function applyVolume(v: number, persist: boolean): void {
  volume = clampVolume(v);
  if (volume > 0) lastVolume = volume;
  player?.setVolume(volume);
  volumeControl.setTrigger(volumeIcon(volume));
  volumeControl.setTriggerLabel(volume > 0 ? 'Mute' : 'Unmute');
  if (persist) void chrome.storage.local.set({ [KEY_VOLUME]: volume });
}

function toggleMute(): void {
  const next = volume > 0 ? 0 : lastVolume > 0 ? lastVolume : 0.5;
  volumeControl.setValue(next);
  applyVolume(next, true);
}

async function loadSettings(): Promise<void> {
  const s = await chrome.storage.local.get([KEY_MODEL, KEY_VOICE, KEY_SPEED, KEY_VOLUME]);
  ttsModel = resolvePlayableTtsModel(s[KEY_MODEL]);
  voice = isKnownVoice(s[KEY_VOICE]) ? s[KEY_VOICE] : DEFAULT_VOICE;
  speed = typeof s[KEY_SPEED] === 'number' ? clampSpeed(s[KEY_SPEED]) : 1;
  volume = typeof s[KEY_VOLUME] === 'number' ? clampVolume(s[KEY_VOLUME]) : 1;
  if (volume > 0) lastVolume = volume;
  els.modelSelect.value = ttsModel;
  voiceSelect.setValue(voice);
  speedControl.setValue(speed);
  speedControl.setTrigger(formatSpeed(speed));
  volumeControl.setValue(volume);
  volumeControl.setTrigger(volumeIcon(volume));
  volumeControl.setTriggerLabel(volume > 0 ? 'Mute' : 'Unmute');
  reflectModelAvailability();
}

function reflectModelAvailability(): void {
  const playable = isPlayableTtsModel(ttsModel);
  els.modelSelect.title = playable
    ? 'Voice model'
    : `${ttsModelLabel(ttsModel)} is not wired into playback yet.`;
  renderTransport();
  if (!playable) {
    setBanner(
      `${ttsModelLabel(ttsModel)} is not wired into playback yet. ${ttsModelPrototypeNote(ttsModel)} Choose Kokoro to play articles.`,
      'info',
    );
  } else {
    const warning = ttsModelWarningNote(ttsModel);
    if (warning && (mode === 'idle' || mode === 'done')) {
      setBanner(warning, 'info');
    } else if (mode === 'idle' || mode === 'done') {
      setBanner(null);
    }
  }
}

// ── Active-tab following ─────────────────────────────────────────────────────

async function currentActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  // Prefer our own window; fall back to the focused window if we never resolved
  // one (e.g. getCurrent() returned no id) so the panel still shows something.
  const query =
    myWindowId === chrome.windows.WINDOW_ID_NONE
      ? { active: true, lastFocusedWindow: true }
      : { active: true, windowId: myWindowId };
  const [tab] = await chrome.tabs.query(query);
  return tab;
}

// A pending extraction is only valid for the tab that asked for it. When we
// commit to showing a *different* tab (exact-match or a cache restore), drop the
// in-flight request so its late result can't paint over the tab now on screen.
function abandonPendingFor(tabId: number): void {
  if (pendingExtract && pendingExtract.tabId !== tabId) {
    pendingExtract = null;
    els.refresh.classList.remove('busy');
  }
}

// Decide what to show for a tab. Already showing it → nothing. Audio playing →
// don't interrupt, just badge the refresh button. Idle → restore a cached read
// for this exact URL, or extract it fresh.
async function followTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const url = tab.url ?? '';
  // Drop any extraction still in flight for a *different* tab up front, before
  // the async cache read below. Otherwise that prior tab's late reply
  // (EXTRACT_RESULT/FAILED/PDF) could land during the await and paint over the
  // tab we're now committing to — pendingExtract isn't gated by followToken.
  abandonPendingFor(tab.id);
  if (tab.id === loadedTabId && url === loadedUrl) {
    els.refresh.classList.remove('busy');
    setTabDrift(false);
    return;
  }
  if (isActive()) {
    setTabDrift(true);
    return;
  }
  const myToken = ++followToken;
  const cached = url ? await readTabArticle(tab.id) : undefined;
  if (myToken !== followToken) return; // a newer switch superseded this one
  if (cached && cached.url === url) {
    const pos = await readTabPosition(tab.id);
    if (myToken !== followToken) return;
    abandonPendingFor(tab.id);
    els.refresh.classList.remove('busy');
    loadedTabId = tab.id;
    loadedUrl = url;
    setArticle(cached.article);
    currentBlock = clamp(pos);
    highlight(currentBlock, false);
    updateProgress();
    setTabDrift(false);
    joinSession(tab.id); // a live session for this tab? mirror it
  } else {
    extractTab(tab);
  }
}

// The minimal tab shape the extraction paths need. A real chrome.tabs.Tab
// satisfies it, and the EXTRACT_PDF handler can synthesize one from a tab id +
// URL without fabricating the rest of the Tab fields.
type TabRef = Pick<chrome.tabs.Tab, 'id' | 'url'>;

// Pick the extraction path for a tab: PDFs are parsed in-panel by pdf.js; every
// other page goes through the SW → content-script Readability path.
function extractTab(tab: chrome.tabs.Tab): void {
  const url = tab.url ?? '';
  if (url && isPdfUrl(url)) void loadPdf(tab);
  else requestExtract(tab);
}

// Ask the SW to (re)extract a specific tab. All panel-initiated extraction goes
// through here so a result can be matched back to the tab that asked for it.
function requestExtract(tab: TabRef): void {
  if (tab.id === undefined) return;
  pendingExtract = { tabId: tab.id, url: tab.url ?? '' };
  setTabDrift(false);
  els.refresh.classList.add('busy');
  post({ to: 'sw', type: 'EXTRACT_REQUEST', tabId: tab.id });
}

// ── Shared session: publish, intents, follower reflection ────────────────────

// Announce our state to the SW (→ the widget follower). Guarded to owner only:
// this both avoids follower noise and breaks the publish→relay→publish loop.
function publishSession(): void {
  if (sessionRole !== 'owner' || sessionTabId === null || !article) return;
  post({
    to: 'sw',
    type: 'SESSION_SYNC',
    owner: 'panel',
    tabId: sessionTabId,
    mode: mode === 'error' ? 'idle' : mode,
    block: currentBlock,
    total: article.blocks.length,
    title: article.title,
  });
}

// Forward a transport action to the owner (used when this panel is a follower).
function sendIntent(action: 'toggle' | 'seek' | 'stop', block?: number): void {
  if (sessionTabId === null) return;
  post({ to: 'sw', type: 'TRANSPORT_INTENT', tabId: sessionTabId, action, block });
}

// Mirror the owner's session onto this panel without playing audio.
function reflectSession(
  tabId: number,
  m: SessionMode,
  block: number,
  _total: number,
): void {
  if (sessionRole === 'owner') yieldLocal(); // we were demoted — silence our audio
  sessionRole = 'follower';
  sessionTabId = tabId;
  followerMode = m;
  if (article) {
    currentBlock = clamp(block);
    highlight(currentBlock, false);
    updateProgress();
  }
  renderTransport();
}

// We owned the session but another surface took over the engine. Silence our
// local player WITHOUT messaging the engine (it now belongs to the new owner).
function yieldLocal(): void {
  player?.flush();
  epoch += 1; // drop any late chunk from our superseded run
  userPaused = false;
  producerPaused = false;
  mode = 'idle';
}

// Ask the SW whether a session is live for `tabId` so we can show follower state
// immediately on (re)joining a tab. No-op while we own a session.
function joinSession(tabId: number): void {
  if (sessionRole === 'owner') return;
  sessionRole = 'idle';
  followerMode = null;
  sessionTabId = null;
  renderTransport();
  post({ to: 'sw', type: 'SESSION_QUERY', from: 'panel', tabId });
}

// Manual refresh: load the active tab now, replacing whatever is playing.
async function refreshActiveTab(): Promise<void> {
  const tab = await currentActiveTab();
  if (!tab || tab.id === undefined) return;
  if (isActive()) stop(); // explicit user action: stop and reload
  extractTab(tab);
}

// ── PDF reading ──────────────────────────────────────────────────────────────

const FILE_ACCESS_HINT =
  'To read local PDFs, enable “Allow access to file URLs” for Audiofi in chrome://extensions.';

function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function pdfTitleFromUrl(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return name.replace(/\.pdf$/i, '') || 'PDF document';
  } catch {
    return 'PDF document';
  }
}

function hasPdfMagic(bytes: ArrayBuffer): boolean {
  const h = new Uint8Array(bytes.slice(0, 5));
  // "%PDF-"
  return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46 && h[4] === 0x2d;
}

// HEAD-probe a URL's MIME type to catch PDFs served from a `.pdf`-less URL
// (e.g. arxiv.org/pdf/<id>). The content script's contentType signal is the fast
// path, but it can't see Chrome's built-in PDF viewer in a real browser — Chrome
// refuses to inject content scripts there — so the panel, which always runs and
// holds <all_urls> host access, sniffs the type itself. A blocked/failed probe
// returns false (treated as non-PDF), so this never makes a page less readable.
async function probePdfContentType(url: string): Promise<boolean> {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) return false;
  const type = res.headers.get('content-type') ?? '';
  return /^application\/pdf\b/i.test(type.trim());
}

class PdfFileAccessError extends Error {}

async function fetchPdfBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('file://') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    throw new PdfFileAccessError();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the PDF (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

// Fetch + parse a PDF tab into the reader. Token-guarded against a newer tab
// switch like followTab; pdf.js is dynamic-imported so it costs nothing until a
// PDF is actually opened. Results don't arrive via EXTRACT_RESULT, so this owns
// its own settle (and the refresh busy spinner).
async function loadPdf(
  tab: TabRef,
  opts: { htmlFallback?: boolean } = {},
): Promise<void> {
  if (tab.id === undefined) return;
  // `htmlFallback` (default) re-runs HTML extraction when the bytes turn out not
  // to be a PDF — right for a `.pdf` URL that actually serves HTML. The content
  // script's contentType signal already knows it's a PDF, so that path disables
  // it to avoid bouncing back into extraction (which would re-detect the PDF).
  const htmlFallback = opts.htmlFallback ?? true;
  const tabId = tab.id;
  const url = tab.url ?? '';
  const myToken = ++followToken;
  pendingExtract = null;
  setTabDrift(false);
  els.refresh.classList.add('busy');

  const failPlaceholder = (text: string, tone: 'info' | 'error'): void => {
    els.refresh.classList.remove('busy');
    loadedTabId = tabId; // mark this tab as shown so we don't re-parse on return
    loadedUrl = url;
    showPlaceholder();
    setBanner(text, tone);
  };

  let bytes: ArrayBuffer;
  try {
    bytes = await fetchPdfBytes(url);
  } catch (err) {
    if (myToken !== followToken) return;
    if (err instanceof PdfFileAccessError) failPlaceholder(FILE_ACCESS_HINT, 'info');
    else failPlaceholder(err instanceof Error ? err.message : 'Could not read this PDF.', 'error');
    return;
  }
  if (myToken !== followToken) return;

  // Bytes aren't a PDF after all. For a `.pdf` URL that actually serves HTML,
  // hand off to the normal extractor (which then owns the busy spinner). When
  // the content script already told us it's a PDF (htmlFallback disabled), don't
  // bounce back into extraction — surface the failure instead.
  if (!hasPdfMagic(bytes)) {
    if (htmlFallback) requestExtract(tab);
    else failPlaceholder('This PDF could not be read.', 'error');
    return;
  }

  let article: ExtractedArticle | null;
  try {
    const { pdfToArticle } = await import('../content/pdf');
    article = await pdfToArticle(bytes, url, pdfTitleFromUrl(url));
  } catch (err) {
    if (myToken !== followToken) return;
    failPlaceholder(
      err instanceof Error ? `Could not read this PDF: ${err.message}` : 'Could not read this PDF.',
      'error',
    );
    return;
  }
  if (myToken !== followToken) return;
  els.refresh.classList.remove('busy');

  if (!article || article.blocks.length === 0) {
    loadedTabId = tabId;
    loadedUrl = url;
    showPlaceholder();
    setBanner('No readable text found in this PDF.', 'info');
    return;
  }
  loadedTabId = tabId;
  loadedUrl = url;
  setArticle(article);
  currentBlock = 0;
  highlight(0, false);
  updateProgress();
  cacheArticle(tabId, url, article);
  joinSession(tabId); // a live session for this tab? mirror it
}

function setTabDrift(on: boolean): void {
  els.refresh.classList.toggle('has-update', on);
  const label = on
    ? 'Active tab changed — click to load this page'
    : 'Reload this page';
  els.refresh.title = label;
  els.refresh.setAttribute('aria-label', label);
}

function watchTabs(): void {
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (windowId !== myWindowId) return;
    chrome.tabs.get(tabId).then((tab) => followTab(tab)).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    // Only our window's active tab, and only on a real navigation / load finish.
    if (tab.windowId !== myWindowId || !tab.active) return;
    if (changeInfo.url || changeInfo.status === 'complete') void followTab(tab);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove([tabArtKey(tabId), tabPosKey(tabId)]);
  });
}

async function readTabArticle(id: number): Promise<TabArticle | undefined> {
  const s = await chrome.storage.session.get(tabArtKey(id));
  return s[tabArtKey(id)] as TabArticle | undefined;
}

async function readTabPosition(id: number): Promise<number> {
  const s = await chrome.storage.session.get(tabPosKey(id));
  const p = s[tabPosKey(id)];
  return typeof p === 'number' ? p : 0;
}

function cacheArticle(id: number, url: string, a: ExtractedArticle): void {
  void chrome.storage.session.set({
    [tabArtKey(id)]: { url, article: a } satisfies TabArticle,
    [tabPosKey(id)]: 0,
  });
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
  reflectModelAvailability();
}

// Tear down the reader view and show the empty-state placeholder (e.g. when the
// active tab has no extractable article).
function showPlaceholder(): void {
  article = null;
  blockEls = [];
  els.header.hidden = true;
  els.controls.hidden = true;
  els.body.hidden = true;
  els.placeholder.hidden = false;
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

// Banner tones: `info` (amber — a first-run wait or caveat worth attention),
// `muted` (subtle — transient progress that shouldn't shout), `error` (red).
type BannerTone = 'info' | 'muted' | 'error';
const BANNER_BASE = 'rounded-lg px-3 py-2.5 text-sm';
const BANNER_TONE: Record<BannerTone, string> = {
  info: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  muted:
    'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
  error: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

function setBanner(text: string | null, tone: BannerTone = 'info'): void {
  els.banner.hidden = text === null;
  els.banner.textContent = text ?? '';
  els.banner.className = `${BANNER_BASE} ${BANNER_TONE[tone]}`;
}

function setMode(next: Mode): void {
  mode = next;
  renderTransport();
  publishSession();
}

// Render the transport controls from the *effective* mode: a follower reflects
// the owner's mode; otherwise our own local `mode`. Kept separate from `setMode`
// so a follower can update its buttons without mutating local audio state.
function renderTransport(): void {
  const shown: Mode | SessionMode = followerMode ?? mode;
  const playing = shown === 'playing';
  els.play.innerHTML = playing ? ICONS.pause : ICONS.play;
  els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  els.play.title = playing ? 'Pause' : 'Play';
  const hasArticle = article !== null;
  const canPlaySelectedModel = isPlayableTtsModel(ttsModel);
  els.play.disabled = !hasArticle || !canPlaySelectedModel;
  els.prev.disabled = !hasArticle;
  els.next.disabled = !hasArticle;
  els.stop.disabled = !hasArticle || shown === 'idle';
}

// ── Controls ─────────────────────────────────────────────────────────────────

function wireControls(): void {
  els.themeToggle.addEventListener('click', async () => {
    els.themeToggle.innerHTML = themeIcon(await cycleTheme());
  });
  // A mouse-activated transport button keeps DOM focus, which would make the
  // space-to-play shortcut re-fire that button instead of toggling play. Drop
  // focus after a pointer click (detail > 0); keyboard activation (detail === 0)
  // keeps focus so the focus ring and Tab order are preserved.
  const blurIfPointer = (e: MouseEvent): void => {
    if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
  };
  els.play.addEventListener('click', (e) => { blurIfPointer(e); void togglePlay(); });
  els.stop.addEventListener('click', (e) => { blurIfPointer(e); stop(); });
  els.prev.addEventListener('click', (e) => { blurIfPointer(e); seekTo(currentBlock - 1); });
  els.next.addEventListener('click', (e) => { blurIfPointer(e); seekTo(currentBlock + 1); });
  els.refresh.addEventListener('click', (e) => { blurIfPointer(e); void refreshActiveTab(); });

  // Voice/speed changes are handled by the control callbacks in buildControls().

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
  if (sessionRole === 'follower') {
    sendIntent('toggle'); // the widget owns audio — let it toggle
    return;
  }
  if (!article) return;
  if (!isPlayableTtsModel(ttsModel)) {
    reflectModelAvailability();
    return;
  }
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
  if (!isPlayableTtsModel(ttsModel)) {
    reflectModelAvailability();
    return;
  }
  currentBlock = clamp(fromBlock);
  // We become the session owner. Capture the tab now (not read live) so our
  // published syncs stay attributed to the right tab even if the active tab
  // drifts during playback.
  sessionRole = 'owner';
  sessionTabId = loadedTabId;
  followerMode = null;
  ensurePlayer();
  player!.flush();
  player!.setExpectMore(true);
  epoch += 1;
  userPaused = false;
  producerPaused = false;
  void player!.resume();
  highlight(currentBlock);
  updateProgress();
  setBanner('Preparing voice…', 'muted');
  // Establish ownership in the SW (SYNTH_START) BEFORE the first publish, so the
  // SW doesn't drop our SESSION_SYNC as coming from a non-owner. setMode then
  // publishes 'loading' to the follower.
  post({
    to: 'sw',
    type: 'SYNTH_START',
    blocks: article.blocks,
    model: ttsModel,
    voice,
    speed,
    fromBlock: currentBlock,
    epoch,
    sink: 'panel',
    tabId: loadedTabId ?? undefined,
  });
  setMode('loading');
  post({ to: 'sw', type: 'SESSION_STATE', phase: 'synthesizing' });
}

function seekTo(target: number): void {
  if (sessionRole === 'follower') {
    sendIntent('seek', clamp(target)); // the widget owns audio — let it seek
    return;
  }
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
    publishSession(); // if we own a finished session, let the follower track the cursor
  }
}

function stop(): void {
  if (sessionRole === 'follower') {
    sendIntent('stop'); // the widget owns audio — let it stop
    return;
  }
  post({ to: 'sw', type: 'SYNTH_STOP' });
  player?.flush();
  epoch += 1; // drop any chunk still in flight from the cancelled run
  userPaused = false;
  producerPaused = false;
  setMode('idle'); // publishes 'idle' (still owner here) → SW ends the session
  sessionRole = 'idle';
  sessionTabId = null;
  followerMode = null;
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
  player.setVolume(volume);
  player.onChunkStart = (chunk) => {
    currentBlock = chunk.blockIndex;
    if (mode === 'loading') setMode('playing');
    highlight(currentBlock);
    updateProgress();
    persistPosition();
    publishSession(); // mirror the advancing block to the follower
  };
  player.onChunkEnd = () => {
    syncBackpressure();
  };
  player.onDrained = () => {
    setMode('done');
    setBanner('Finished.', 'muted');
    post({ to: 'sw', type: 'SESSION_STATE', phase: 'idle' });
  };
}

// ── Incoming messages ────────────────────────────────────────────────────────

function listen(): void {
  onMessage('panel', (msg) => {
    switch (msg.type) {
      case 'EXTRACT_RESULT': {
        // Ignore a late result for a tab we've since navigated away from. Clear
        // the spinner only once we've confirmed this result is the one we're
        // waiting on — a superseded result must not stop a spinner that a newer
        // op (e.g. an in-flight loadPdf) now owns.
        if (!pendingExtract || msg.tabId !== pendingExtract.tabId) break;
        els.refresh.classList.remove('busy');
        loadedTabId = pendingExtract.tabId;
        loadedUrl = pendingExtract.url;
        pendingExtract = null;
        setTabDrift(false);
        setArticle(msg.article);
        currentBlock = 0;
        highlight(0, false);
        updateProgress();
        cacheArticle(loadedTabId, loadedUrl, msg.article);
        joinSession(loadedTabId); // a live session for this tab? mirror it
        break;
      }

      case 'EXTRACT_FAILED': {
        if (!pendingExtract || msg.tabId !== pendingExtract.tabId) break;
        const target = { id: pendingExtract.tabId, url: pendingExtract.url };
        // A PDF served from a `.pdf`-less URL fails HTML extraction in a real
        // browser, where Chrome's PDF viewer hides its contentType from our
        // content script. Before declaring "not an article", probe the URL's MIME
        // type from the panel and parse it as a PDF if so. pendingExtract is left
        // set so a tab switch (abandonPendingFor) cancels the in-flight probe.
        if (
          msg.reason !== 'error' &&
          /^https?:/i.test(target.url) &&
          !isPdfUrl(target.url)
        ) {
          void maybeLoadPdfFallback(target, msg.reason);
          break;
        }
        renderExtractFailure(target.id, target.url, msg.reason);
        break;
      }

      case 'EXTRACT_PDF': {
        // The content script identified the pending tab as a PDF (by MIME type),
        // so a `.pdf`-less URL still reads. Match it to the extract we asked for
        // so a stale signal can't hijack a tab we've since left, then parse it
        // in-panel. htmlFallback is off: the PDF verdict is authoritative, and
        // re-running extraction would just re-detect the PDF (a loop).
        if (!pendingExtract || msg.tabId !== pendingExtract.tabId) break;
        const target: TabRef = { id: pendingExtract.tabId, url: msg.url || pendingExtract.url };
        pendingExtract = null;
        void loadPdf(target, { htmlFallback: false });
        break;
      }

      case 'SESSION_SYNC': {
        // The widget (or our own session, echoed) reporting state. Only mirror a
        // session for the tab we're currently showing.
        if (msg.tabId !== loadedTabId) break;
        if (msg.mode === 'idle') {
          // Authoritative session-end from the SW (every idle it sends is — an owner
          // never receives its own idle echo). A follower drops its mirrored state;
          // an owner that's been preempted (another tab took the single engine, or
          // our content tab closed) yields its audio silently, since the engine now
          // belongs elsewhere. We keep the article + cursor either way.
          if (sessionRole === 'owner') yieldLocal();
          sessionRole = 'idle';
          sessionTabId = null;
          followerMode = null;
          renderTransport();
          break;
        }
        if (msg.owner === 'panel') break; // a non-idle echo of our own ownership
        reflectSession(msg.tabId, msg.mode, msg.block, msg.total);
        break;
      }

      case 'TRANSPORT_INTENT': {
        // A follower (the widget) controlling the session we own. Execute locally;
        // our existing methods publish the result back to it.
        if (sessionRole !== 'owner') break;
        if (msg.action === 'toggle') void togglePlay();
        else if (msg.action === 'seek') { if (msg.block !== undefined) seekTo(msg.block); }
        else if (msg.action === 'stop') stop();
        break;
      }

      case 'MODEL_STATUS':
        if (msg.state === 'loading') setBanner('Loading voice model…', 'muted');
        else if (msg.state === 'ready') {
          setBanner(
            msg.backend === 'wasm' ? 'Using CPU mode (slower).' : null,
          );
        } else {
          setBanner(`Model error: ${msg.message ?? 'unknown'}`, 'error');
          setMode('error');
        }
        break;

      case 'MODEL_DOWNLOAD_PROGRESS':
        setBanner(`Downloading model… ${Math.round(msg.progress * 100)}%`);
        break;

      case 'SYNTH_PROGRESS':
        // While still buffering the first audio, show a subtle, count-free
        // "Synthesizing…" — the producer races ahead of playback, so a numeric
        // done/total reads as out-of-sync and over-emphasized to the listener.
        if (msg.epoch === epoch && mode === 'loading' && msg.total > 0) {
          setBanner('Synthesizing…', 'muted');
        }
        break;

      case 'SYNTH_CHUNK':
        if (msg.epoch === epoch) handleChunk(msg);
        break;

      case 'SYNTH_DONE':
        if (msg.epoch === epoch) player?.setExpectMore(false);
        break;

      case 'ERROR':
        setBanner(`Error: ${msg.message}`, 'error');
        break;

      default:
        break;
    }
  });
}

// HTML extraction failed for an http(s) tab. It may be a PDF the content script
// couldn't see (Chrome's PDF viewer). Probe the MIME type and, if it's a PDF,
// parse it in-panel; otherwise render the failure we deferred. The busy spinner
// stays on across the probe so the panel keeps showing work in progress.
async function maybeLoadPdfFallback(
  target: { id: number; url: string },
  reason: 'not-article' | 'empty',
): Promise<void> {
  let isPdf = false;
  try {
    isPdf = await probePdfContentType(target.url);
  } catch {
    isPdf = false;
  }
  // A tab switch (or a same-tab re-navigation) during the probe clears or
  // replaces pendingExtract — bail so we don't paint over the tab now on screen.
  if (
    !pendingExtract ||
    pendingExtract.tabId !== target.id ||
    pendingExtract.url !== target.url
  ) {
    return;
  }
  if (isPdf) {
    // loadPdf owns pendingExtract and the spinner from here (htmlFallback off:
    // the MIME type is authoritative, so don't bounce back into extraction).
    void loadPdf(target, { htmlFallback: false });
    return;
  }
  renderExtractFailure(target.id, target.url, reason);
}

// Show the empty-state for a tab whose page has no extractable article, clearing
// any stale article from a previous tab so the panel matches what's on screen.
function renderExtractFailure(
  tabId: number,
  url: string,
  reason: 'not-article' | 'empty' | 'error',
): void {
  els.refresh.classList.remove('busy');
  loadedTabId = tabId;
  loadedUrl = url;
  pendingExtract = null;
  setTabDrift(false);
  showPlaceholder();
  const base = extractFailureText(reason);
  setBanner(base, reason === 'error' ? 'error' : 'info');
  // If we couldn't even see the tab's URL, a local file (e.g. a PDF) with file
  // access disabled is the likely cause — guide the user there.
  if (!url) {
    void chrome.extension.isAllowedFileSchemeAccess().then((ok) => {
      if (!ok && !loadedUrl) setBanner(`${base} ${FILE_ACCESS_HINT}`, 'info');
    });
  }
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
  if (loadedTabId === null) return;
  void chrome.storage.session.set({ [tabPosKey(loadedTabId)]: currentBlock });
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
