// In-page compact player (injected next to the article title). A self-contained
// playback surface: on first Play it extracts the article and asks the offscreen
// engine to synthesize with sink='content', so audio is routed back to this tab
// and played through the page's own Web Audio context (the click is the user
// gesture that unlocks it). The side panel remains the full UI; this is a
// quick-launch mini player. Rendered in a shadow root so page CSS can't bleed in.

import { onMessage, post } from '../shared/messages';
import type { ExtractedArticle, SessionMode } from '../shared/types';
import { AudioPlayer, type QueuedChunk } from '../panel/player';
import { ICONS } from '../panel/icons';
import { decodePcm } from '../shared/pcm';
import { DEFAULT_VOICE, isKnownVoice, VOICES } from '../shared/voices';
import {
  DEFAULT_TTS_MODEL,
  resolvePlayableTtsModel,
  type TtsModelId,
} from '../shared/tts-models';
import { Select, SELECT_STYLE } from '../ui/select';
import { Slider, SLIDER_STYLE } from '../ui/slider';
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
  clampVolume,
} from '../ui/volume';

const HIGH_WATER = 3;
const LOW_WATER = 1;

let mounted = false;

/** Inject the widget once, anchored after the article's main title. */
export function mountWidget(): void {
  if (mounted) return;
  const anchor = document.querySelector<HTMLElement>('article h1, main h1, h1');
  if (!anchor) return;
  mounted = true;
  new Widget(anchor);
}

const STYLE = `
  :host {
    all: initial;
    --a2a-surface: #fff; --a2a-text: #171717; --a2a-muted: #737373;
    --a2a-border: #e5e5e5; --a2a-border-hover: #a3a3a3; --a2a-hover: #f5f5f5;
    --a2a-solid: #171717; --a2a-track: #e5e5e5; --a2a-tick: #d4d4d4;
    --a2a-shadow: rgba(0,0,0,.14);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --a2a-surface: #0a0a0a; --a2a-text: #fafafa; --a2a-muted: #a3a3a3;
      --a2a-border: #262626; --a2a-border-hover: #525252; --a2a-hover: #1a1a1a;
      --a2a-solid: #fafafa; --a2a-track: #262626; --a2a-tick: #404040;
      --a2a-shadow: rgba(0,0,0,.6);
    }
  }
  .pill {
    display: flex; align-items: center; gap: 10px;
    margin: 12px 0; padding: 8px 10px;
    font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #fff; color: #171717;
    border: 1px solid #e5e5e5; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
    max-width: 420px;
  }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; flex: none;
    border: 1px solid #e5e5e5; border-radius: 8px;
    background: #fff; color: #404040; cursor: pointer; padding: 0;
  }
  .btn:hover { border-color: #a3a3a3; color: #171717; }
  .btn.play { background: #171717; color: #fff; border-color: #171717; }
  .btn.play:hover { background: #404040; }
  .btn.ghost { border: none; background: transparent; width: 26px; height: 26px; color: #a3a3a3; }
  .btn.more[aria-expanded="true"] { background: #f5f5f5; color: #171717; }
  .btn:disabled { opacity: .4; cursor: default; }
  .mid { flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: 5px; }
  .label { font-size: 12px; color: #525252; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 4px; border-radius: 999px; background: #e5e5e5; overflow: hidden; cursor: pointer; }
  .fill { height: 100%; width: 0%; background: #171717; transition: width .2s ease; }
  svg { width: 16px; height: 16px; }
  @media (prefers-color-scheme: dark) {
    .pill { background: #0a0a0a; color: #fafafa; border-color: #262626; box-shadow: 0 1px 3px rgba(0,0,0,.5); }
    .btn { background: #0a0a0a; border-color: #262626; color: #d4d4d4; }
    .btn:hover { border-color: #525252; color: #fafafa; }
    .btn.play { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
    .btn.play:hover { background: #d4d4d4; }
    .btn.more[aria-expanded="true"] { background: #1a1a1a; color: #fafafa; }
    .label { color: #a3a3a3; }
    .bar { background: #262626; }
    .fill { background: #fafafa; }
  }
  @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }

  .adv {
    margin: -4px 0 12px; padding: 14px; max-width: 420px;
    display: flex; flex-direction: column; gap: 16px;
    font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #fff; color: #171717;
    border: 1px solid #e5e5e5; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
  }
  .adv[hidden] { display: none; }
  .adv-row { display: flex; flex-direction: column; gap: 7px; }
  .adv-row .head { display: flex; align-items: baseline; justify-content: space-between; }
  .adv-row label { font-size: 12px; font-weight: 600; color: #404040; }
  .adv-row .val { font-size: 12px; color: #525252; font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: dark) {
    .adv { background: #0a0a0a; color: #fafafa; border-color: #262626; box-shadow: 0 1px 3px rgba(0,0,0,.5); }
    .adv-row label { color: #d4d4d4; }
    .adv-row .val { color: #a3a3a3; }
  }
  ${SELECT_STYLE}
  ${SLIDER_STYLE}
`;

type Mode = 'idle' | 'loading' | 'playing' | 'paused' | 'done';

class Widget {
  private play!: HTMLButtonElement;
  private stop!: HTMLButtonElement;
  private more!: HTMLButtonElement;
  private label!: HTMLDivElement;
  private bar!: HTMLDivElement;
  private fill!: HTMLDivElement;
  private host!: HTMLDivElement;
  private adv!: HTMLDivElement;
  private speedVal!: HTMLSpanElement;
  private volumeVal!: HTMLSpanElement;
  private voiceSelect!: Select;
  private speedSlider!: Slider;
  private volumeSlider!: Slider;
  private unlisten: (() => void) | null = null;
  private advOpen = false;
  private readonly onDocPointerDown: (e: PointerEvent) => void;

  private mode: Mode = 'idle';
  private article: ExtractedArticle | null = null;
  private player: AudioPlayer | null = null;
  private epoch = 0;
  private currentBlock = 0;
  private userPaused = false;
  private producerPaused = false;
  // Shared-session role (see panel.ts for the full model): 'owner' plays audio
  // here; 'follower' mirrors the side panel and forwards controls as intents;
  // 'idle' has no session. `followerMode` reflects the owner's mode while we
  // follow, so the buttons show it without our local `mode` claiming playback.
  private role: 'idle' | 'owner' | 'follower' = 'idle';
  private followerMode: SessionMode | null = null;
  private sessionTabId: number | null = null;
  // Block count of the session we're following (we may have no local article).
  private followerTotal = 0;
  private voice = DEFAULT_VOICE;
  private ttsModel: TtsModelId = DEFAULT_TTS_MODEL;
  private speed = 1;
  private volume = 1;
  // Resolves once persisted voice/speed are loaded; start() awaits it so the
  // first run uses the user's settings even if Play is pressed immediately.
  private settingsReady: Promise<void>;

  constructor(anchor: HTMLElement) {
    const host = document.createElement('div');
    host.id = 'a2a-widget';
    this.host = host;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="pill" role="group" aria-label="Listen to this article">
        <button class="btn play" type="button" aria-label="Play">${ICONS.play}</button>
        <div class="mid">
          <div class="label">Listen to this article</div>
          <div class="bar"><div class="fill"></div></div>
        </div>
        <button class="btn stop" type="button" aria-label="Stop" disabled>${ICONS.stop}</button>
        <button class="btn ghost more" type="button" aria-label="More controls"
          aria-haspopup="true" aria-expanded="false" title="More controls">${ICONS.more}</button>
        <button class="btn ghost close" type="button" aria-label="Dismiss" title="Dismiss">&times;</button>
      </div>
      <div class="adv" role="group" aria-label="Playback settings" hidden>
        <div class="adv-row">
          <label id="a2a-voice-label">Voice</label>
          <div class="voice-slot"></div>
        </div>
        <div class="adv-row">
          <div class="head"><label>Speed</label><span class="val spd-val">1×</span></div>
          <div class="speed-slot"></div>
        </div>
        <div class="adv-row">
          <div class="head"><label>Volume</label><span class="val vol-val">100%</span></div>
          <div class="volume-slot"></div>
        </div>
      </div>`;

    this.play = root.querySelector('.play')!;
    this.stop = root.querySelector('.stop')!;
    this.more = root.querySelector('.more')!;
    this.label = root.querySelector('.label')!;
    this.bar = root.querySelector('.bar')!;
    this.fill = root.querySelector('.fill')!;
    this.adv = root.querySelector('.adv')!;
    this.speedVal = root.querySelector('.spd-val')!;
    this.volumeVal = root.querySelector('.vol-val')!;

    this.voiceSelect = new Select({
      options: VOICES.map((v) => ({ value: v.id, label: v.label })),
      value: this.voice,
      ariaLabel: 'Voice',
      onChange: (v) => this.onVoiceChange(v),
    });
    root.querySelector('.voice-slot')!.append(this.voiceSelect.el);

    this.speedSlider = new Slider({
      min: SPEED_MIN,
      max: SPEED_MAX,
      step: SPEED_STEP,
      value: this.speed,
      toFraction: speedToFraction,
      toValue: speedToValue,
      notches: SPEED_NOTCHES,
      format: formatSpeed,
      ariaLabel: 'Playback speed',
      onInput: (v) => this.onSpeedInput(v),
      onChange: (v) => this.onSpeedChange(v),
    });
    root.querySelector('.speed-slot')!.append(this.speedSlider.el);

    this.volumeSlider = new Slider({
      min: VOLUME_MIN,
      max: VOLUME_MAX,
      step: VOLUME_STEP,
      value: this.volume,
      toFraction: volumeToFraction,
      toValue: volumeToValue,
      notches: [],
      format: formatVolume,
      ariaLabel: 'Volume',
      onInput: (v) => this.onVolumeInput(v),
      onChange: (v) => this.onVolumeChange(v),
    });
    root.querySelector('.volume-slot')!.append(this.volumeSlider.el);

    this.play.addEventListener('click', () => void this.onPlay());
    this.stop.addEventListener('click', () => this.onStop());
    this.more.addEventListener('click', () => this.toggleAdv());
    this.bar.addEventListener('click', (e) => this.onBarClick(e));
    root.querySelector('.close')!.addEventListener('click', () => void this.dismiss());

    this.onDocPointerDown = (e) => {
      if (this.advOpen && !e.composedPath().includes(this.host)) this.toggleAdv(false);
    };

    anchor.insertAdjacentElement('afterend', host);
    this.listen();
    // If the panel is already reading this tab, learn the live session so we show
    // follower state immediately. The SW stamps our tab id from the sender.
    post({ to: 'sw', type: 'SESSION_QUERY', from: 'content', tabId: -1 });
    this.settingsReady = this.loadSettings().then(() => this.reflectSettings());
  }

  /**
   * Tear the widget down completely: stop any in-flight synthesis, release the
   * AudioContext (Chrome caps these per document), drop the message listener, and
   * clear the module-level latch so the page can mount a fresh widget later.
   */
  private async dismiss(): Promise<void> {
    // End the session only if we own it; a follower dismiss must not stop the
    // panel's playback. Either way, cut our own audio.
    if (this.role === 'owner') this.onStop();
    else this.player?.flush();
    this.unlisten?.();
    this.unlisten = null;
    this.voiceSelect.destroy();
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    this.host.remove();
    mounted = false;
    // Release the AudioContext in the background; the UI is already gone.
    const player = this.player;
    this.player = null;
    await player?.close();
  }

  // ── Advanced controls (voice / speed) ────────────────────────────────────────

  private toggleAdv(open = !this.advOpen): void {
    this.advOpen = open;
    this.adv.hidden = !open;
    this.more.setAttribute('aria-expanded', String(open));
    if (open) document.addEventListener('pointerdown', this.onDocPointerDown, true);
    else document.removeEventListener('pointerdown', this.onDocPointerDown, true);
  }

  private reflectSettings(): void {
    this.voiceSelect.setValue(this.voice);
    this.speedSlider.setValue(this.speed);
    this.speedVal.textContent = formatSpeed(this.speed);
    this.volumeSlider.setValue(this.volume);
    this.volumeVal.textContent = formatVolume(this.volume);
  }

  private onVoiceChange(voice: string): void {
    this.voice = voice;
    void chrome.storage.local.set({ 'settings.voice': voice });
    this.restartIfActive();
  }

  private onSpeedInput(speed: number): void {
    this.speed = speed;
    this.speedVal.textContent = formatSpeed(speed);
  }

  private onSpeedChange(speed: number): void {
    this.speed = speed;
    this.speedVal.textContent = formatSpeed(speed);
    void chrome.storage.local.set({ 'settings.speed': speed });
    this.restartIfActive();
  }

  // Volume applies live (it's a gain change, no re-synthesis needed), unlike
  // voice/speed which require re-running the engine.
  private onVolumeInput(volume: number): void {
    this.volume = clampVolume(volume);
    this.volumeVal.textContent = formatVolume(this.volume);
    this.player?.setVolume(this.volume);
  }

  private onVolumeChange(volume: number): void {
    this.onVolumeInput(volume);
    void chrome.storage.local.set({ 'settings.volume': this.volume });
  }

  // A live voice/speed change re-synthesizes from the current block (the buffered
  // audio used the old settings), mirroring the side panel.
  private restartIfActive(): void {
    if (this.mode === 'playing' || this.mode === 'paused' || this.mode === 'loading') {
      void this.start(this.currentBlock);
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.renderTransport();
    this.publishSession();
  }

  // Render the play/stop buttons from the *effective* mode: a follower reflects
  // the owner's mode; otherwise our local `mode`. Separate from `setMode` so a
  // follower updates its buttons without mutating local audio state.
  private renderTransport(): void {
    const shown: Mode | SessionMode = this.followerMode ?? this.mode;
    const playing = shown === 'playing';
    this.play.innerHTML = playing ? ICONS.pause : ICONS.play;
    this.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.stop.disabled = shown === 'idle';
  }

  // ── Shared session: publish, intents, follower reflection ──────────────────

  // Announce our state to the SW (→ the panel follower). Owner-only: avoids
  // follower noise and breaks the publish→relay→publish loop. The widget doesn't
  // know its own tab id; the SW stamps it from the sender.
  private publishSession(): void {
    if (this.role !== 'owner' || !this.article) return;
    post({
      to: 'sw',
      type: 'SESSION_SYNC',
      owner: 'content',
      tabId: this.sessionTabId ?? -1,
      mode: this.mode,
      block: this.currentBlock,
      total: this.article.blocks.length,
      title: this.article.title,
    });
  }

  // Forward a transport action to the owner (used when we're a follower).
  private sendIntent(action: 'toggle' | 'seek' | 'stop', block?: number): void {
    post({ to: 'sw', type: 'TRANSPORT_INTENT', tabId: this.sessionTabId ?? -1, action, block });
  }

  // Mirror the panel's session onto this widget without playing audio. We may
  // have no article (the panel extracted it), so progress is driven from the
  // sync's block/total directly rather than this.article.
  private reflectSession(tabId: number, mode: SessionMode, block: number, total: number, title: string): void {
    if (this.role === 'owner') this.yieldLocal(); // demoted — silence our audio
    this.role = 'follower';
    this.sessionTabId = tabId;
    this.followerMode = mode;
    this.followerTotal = total;
    this.currentBlock = clampBlock(block, total);
    const pct = total <= 1 ? 0 : Math.round((this.currentBlock / (total - 1)) * 100);
    this.fill.style.width = `${pct}%`;
    if (title) this.setLabel(title);
    this.renderTransport();
  }

  // We owned the session but another surface took over the engine. Silence our
  // local player WITHOUT messaging the engine (it now belongs to the new owner).
  private yieldLocal(): void {
    this.player?.flush();
    this.epoch += 1;
    this.userPaused = false;
    this.producerPaused = false;
    this.mode = 'idle';
  }

  private setLabel(text: string): void {
    this.label.textContent = text;
  }

  private updateProgress(): void {
    const total = this.article?.blocks.length ?? 0;
    const pct = total <= 1 ? 0 : Math.round((this.currentBlock / (total - 1)) * 100);
    this.fill.style.width = `${pct}%`;
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  private async onPlay(): Promise<void> {
    if (this.role === 'follower') {
      this.sendIntent('toggle'); // the panel owns audio — let it toggle
      return;
    }
    if (this.mode === 'playing') {
      await this.player?.suspend();
      this.userPaused = true;
      this.syncBackpressure();
      this.setMode('paused');
      return;
    }
    if (this.mode === 'paused') {
      await this.player?.resume();
      this.userPaused = false;
      this.syncBackpressure();
      this.setMode('playing');
      return;
    }
    await this.start(this.mode === 'done' ? 0 : this.currentBlock);
  }

  // Jump to a block. As follower, forward the intent so the owner does it. As
  // owner that's playing, re-synthesize from there; when not playing, just move
  // the cursor (a SYNTH_SEEK would reuse a stale/foreign run in the offscreen).
  private seekTo(block: number): void {
    if (this.role === 'follower') {
      this.sendIntent('seek', block);
      return;
    }
    if (!this.article) return;
    this.currentBlock = clampBlock(block, this.article.blocks.length);
    const active =
      this.mode === 'playing' || this.mode === 'paused' || this.mode === 'loading';
    if (active) {
      this.ensurePlayer();
      this.player!.flush();
      this.player!.setExpectMore(true);
      this.epoch += 1;
      this.userPaused = false;
      this.producerPaused = false;
      void this.player!.resume();
      this.setMode('loading');
      this.updateProgress();
      post({ to: 'sw', type: 'SYNTH_SEEK', fromBlock: this.currentBlock, epoch: this.epoch });
    } else {
      this.updateProgress();
    }
  }

  // Click the progress bar to jump to that point (mirrors clicking a block in the
  // panel). Works whether we own the session or follow it.
  private onBarClick(e: MouseEvent): void {
    const total =
      this.role === 'follower' ? this.followerTotal : this.article?.blocks.length ?? 0;
    if (total <= 1) return;
    const rect = this.bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this.seekTo(Math.round(frac * (total - 1)));
  }

  private async start(fromBlock: number): Promise<void> {
    await this.settingsReady; // voice/speed loaded once at construction
    if (!this.article) {
      this.setLabel('Reading page…');
      const { extractArticle } = await import('./extract');
      const article = extractArticle();
      if (!article || article.blocks.length === 0) {
        this.setLabel("This page doesn't look like an article.");
        return;
      }
      this.article = article;
    }

    this.currentBlock = clampBlock(fromBlock, this.article.blocks.length);
    this.role = 'owner'; // we drive the audio for this session
    this.followerMode = null;
    this.ensurePlayer();
    this.player!.flush();
    this.player!.setExpectMore(true);
    this.epoch += 1;
    this.userPaused = false;
    this.producerPaused = false;
    void this.player!.resume();
    this.setLabel('Preparing voice…');
    this.updateProgress();

    // Establish ownership in the SW (SYNTH_START) BEFORE the first publish, so
    // the SW doesn't drop our SESSION_SYNC as coming from a non-owner. setMode
    // then publishes 'loading' to the follower.
    post({
      to: 'sw',
      type: 'SYNTH_START',
      blocks: this.article.blocks,
      model: this.ttsModel,
      voice: this.voice,
      speed: this.speed,
      fromBlock: this.currentBlock,
      epoch: this.epoch,
      sink: 'content',
    });
    this.setMode('loading');
  }

  private onStop(): void {
    if (this.role === 'follower') {
      this.sendIntent('stop'); // the panel owns audio — let it stop
      return;
    }
    post({ to: 'sw', type: 'SYNTH_STOP' });
    this.player?.flush();
    this.epoch += 1;
    this.userPaused = false;
    this.producerPaused = false;
    this.currentBlock = 0;
    this.updateProgress();
    this.setMode('idle'); // publishes 'idle' (still owner) → SW ends the session
    this.role = 'idle';
    this.sessionTabId = null;
    this.followerMode = null;
    this.setLabel('Listen to this article');
  }

  private async loadSettings(): Promise<void> {
    const s = await chrome.storage.local.get([
      'settings.voice',
      'settings.model',
      'settings.speed',
      'settings.volume',
    ]);
    this.voice = isKnownVoice(s['settings.voice']) ? s['settings.voice'] : DEFAULT_VOICE;
    this.ttsModel = resolvePlayableTtsModel(s['settings.model']);
    this.speed = typeof s['settings.speed'] === 'number' ? clampSpeed(s['settings.speed']) : 1;
    this.volume = typeof s['settings.volume'] === 'number' ? clampVolume(s['settings.volume']) : 1;
  }

  private ensurePlayer(): void {
    if (this.player) return;
    this.player = new AudioPlayer();
    this.player.setVolume(this.volume);
    this.player.onChunkStart = (chunk) => {
      this.currentBlock = chunk.blockIndex;
      if (this.mode === 'loading') {
        this.setMode('playing');
        this.setLabel(this.article?.title ?? 'Playing…');
      }
      this.updateProgress();
      this.publishSession(); // mirror the advancing block to the follower
    };
    this.player.onChunkEnd = () => this.syncBackpressure();
    this.player.onDrained = () => {
      this.setMode('done');
      this.setLabel('Finished.');
    };
  }

  private syncBackpressure(): void {
    const ahead = this.player?.bufferedAhead ?? 0;
    let desired: boolean;
    if (this.userPaused || ahead >= HIGH_WATER) desired = true;
    else if (ahead <= LOW_WATER) desired = false;
    else desired = this.producerPaused;
    if (desired !== this.producerPaused) {
      this.producerPaused = desired;
      post({ to: 'sw', type: 'SYNTH_BACKPRESSURE', pause: desired });
    }
  }

  // ── Incoming offscreen output (relayed by the SW to this tab) ────────────────

  private listen(): void {
    this.unlisten = onMessage('content', (msg) => {
      switch (msg.type) {
        case 'MODEL_STATUS':
          // Model status isn't epoch-stamped (the model loads once, across runs), so
          // a late one can arrive after we've stopped or finished. Ignore it when at
          // rest so it can't clobber the idle/done label.
          if (this.mode === 'idle' || this.mode === 'done') break;
          if (msg.state === 'loading') this.setLabel('Loading voice model…');
          else if (msg.state === 'error') this.setLabel(`Model error: ${msg.message ?? ''}`);
          else if (msg.backend === 'wasm') this.setLabel('Using CPU mode (slower).');
          break;
        case 'MODEL_DOWNLOAD_PROGRESS':
          if (this.mode === 'idle' || this.mode === 'done') break; // stale after stop/finish
          this.setLabel(`Downloading model… ${Math.round(msg.progress * 100)}%`);
          break;
        case 'SYNTH_CHUNK':
          if (msg.epoch === this.epoch) this.handleChunk(msg);
          break;
        case 'SYNTH_DONE':
          if (msg.epoch === this.epoch) this.player?.setExpectMore(false);
          break;
        case 'ERROR':
          this.setLabel(`Error: ${msg.message}`);
          break;
        case 'SESSION_SYNC': {
          // From the panel (or our own echo). The widget is bound to one tab, so
          // any sync the SW routes to us is for our tab.
          if (msg.mode === 'idle') {
            // Authoritative session-end from the SW. A follower drops its mirrored
            // state; an owner preempted by another tab's session yields its audio
            // *silently* (yieldLocal, not onStop) — the engine now belongs to the new
            // owner, so a SYNTH_STOP here would wrongly kill its run.
            if (this.role === 'owner') this.yieldLocal();
            this.role = 'idle';
            this.followerMode = null;
            this.sessionTabId = null;
            this.renderTransport();
            if (this.mode === 'idle') this.setLabel('Listen to this article');
            break;
          }
          if (msg.owner === 'content') break; // echo of our own ownership
          this.reflectSession(msg.tabId, msg.mode, msg.block, msg.total, msg.title);
          break;
        }
        case 'TRANSPORT_INTENT':
          // The panel follower controlling the session we own. Execute locally;
          // our methods publish the result back.
          if (this.role === 'owner') {
            if (msg.action === 'toggle') void this.onPlay();
            else if (msg.action === 'seek' && msg.block !== undefined) this.seekTo(msg.block);
            else if (msg.action === 'stop') this.onStop();
          }
          break;
        default:
          break;
      }
    });
  }

  private handleChunk(
    msg: Extract<import('../shared/messages').Message, { type: 'SYNTH_CHUNK' }>,
  ): void {
    this.ensurePlayer();
    const chunk: QueuedChunk = {
      index: msg.index,
      blockIndex: msg.blockIndex,
      kind: msg.kind,
      pcm: decodePcm(msg.pcm),
      sampleRate: msg.sampleRate,
      durationMs: msg.durationMs,
      text: msg.text,
    };
    this.player!.enqueue(chunk);
    this.syncBackpressure();
  }
}

function clampBlock(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(0, length - 1));
}
