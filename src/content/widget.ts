// In-page compact player (injected next to the article title). A self-contained
// playback surface: on first Play it extracts the article and asks the offscreen
// engine to synthesize with sink='content', so audio is routed back to this tab
// and played through the page's own Web Audio context (the click is the user
// gesture that unlocks it). The side panel remains the full UI; this is a
// quick-launch mini player. Rendered in a shadow root so page CSS can't bleed in.

import { onMessage, post } from '../shared/messages';
import type { ExtractedArticle } from '../shared/types';
import { AudioPlayer, type QueuedChunk } from '../panel/player';
import { ICONS } from '../panel/icons';
import { decodePcm } from '../shared/pcm';
import { DEFAULT_VOICE, isKnownVoice } from '../shared/voices';

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
  :host { all: initial; }
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
  .btn:disabled { opacity: .4; cursor: default; }
  .mid { flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: 5px; }
  .label { font-size: 12px; color: #525252; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 4px; border-radius: 999px; background: #e5e5e5; overflow: hidden; }
  .fill { height: 100%; width: 0%; background: #171717; transition: width .2s ease; }
  svg { width: 16px; height: 16px; }
  @media (prefers-color-scheme: dark) {
    .pill { background: #0a0a0a; color: #fafafa; border-color: #262626; box-shadow: 0 1px 3px rgba(0,0,0,.5); }
    .btn { background: #0a0a0a; border-color: #262626; color: #d4d4d4; }
    .btn:hover { border-color: #525252; color: #fafafa; }
    .btn.play { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
    .btn.play:hover { background: #d4d4d4; }
    .label { color: #a3a3a3; }
    .bar { background: #262626; }
    .fill { background: #fafafa; }
  }
  @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
`;

type Mode = 'idle' | 'loading' | 'playing' | 'paused' | 'done';

class Widget {
  private play!: HTMLButtonElement;
  private stop!: HTMLButtonElement;
  private label!: HTMLDivElement;
  private fill!: HTMLDivElement;
  private host!: HTMLDivElement;
  private unlisten: (() => void) | null = null;

  private mode: Mode = 'idle';
  private article: ExtractedArticle | null = null;
  private player: AudioPlayer | null = null;
  private epoch = 0;
  private currentBlock = 0;
  private userPaused = false;
  private producerPaused = false;
  private voice = DEFAULT_VOICE;
  private speed = 1;

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
        <button class="btn ghost close" type="button" aria-label="Dismiss" title="Dismiss">&times;</button>
      </div>`;

    this.play = root.querySelector('.play')!;
    this.stop = root.querySelector('.stop')!;
    this.label = root.querySelector('.label')!;
    this.fill = root.querySelector('.fill')!;

    this.play.addEventListener('click', () => void this.onPlay());
    this.stop.addEventListener('click', () => this.onStop());
    root.querySelector('.close')!.addEventListener('click', () => void this.dismiss());

    anchor.insertAdjacentElement('afterend', host);
    this.listen();
  }

  /**
   * Tear the widget down completely: stop any in-flight synthesis, release the
   * AudioContext (Chrome caps these per document), drop the message listener, and
   * clear the module-level latch so the page can mount a fresh widget later.
   */
  private async dismiss(): Promise<void> {
    this.onStop(); // posts SYNTH_STOP + flushes synchronously, so audio cuts now
    this.unlisten?.();
    this.unlisten = null;
    this.host.remove();
    mounted = false;
    // Release the AudioContext in the background; the UI is already gone.
    const player = this.player;
    this.player = null;
    await player?.close();
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.play.innerHTML = mode === 'playing' ? ICONS.pause : ICONS.play;
    this.play.setAttribute('aria-label', mode === 'playing' ? 'Pause' : 'Play');
    this.stop.disabled = mode === 'idle';
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

  private async start(fromBlock: number): Promise<void> {
    if (!this.article) {
      this.setLabel('Reading page…');
      const { extractArticle } = await import('./extract');
      const article = extractArticle();
      if (!article || article.blocks.length === 0) {
        this.setLabel("This page doesn't look like an article.");
        return;
      }
      this.article = article;
      await this.loadSettings();
    }

    this.currentBlock = clampBlock(fromBlock, this.article.blocks.length);
    this.ensurePlayer();
    this.player!.flush();
    this.player!.setExpectMore(true);
    this.epoch += 1;
    this.userPaused = false;
    this.producerPaused = false;
    void this.player!.resume();
    this.setMode('loading');
    this.setLabel('Preparing voice…');
    this.updateProgress();

    post({
      to: 'sw',
      type: 'SYNTH_START',
      blocks: this.article.blocks,
      voice: this.voice,
      speed: this.speed,
      fromBlock: this.currentBlock,
      epoch: this.epoch,
      sink: 'content',
    });
  }

  private onStop(): void {
    post({ to: 'sw', type: 'SYNTH_STOP' });
    this.player?.flush();
    this.epoch += 1;
    this.userPaused = false;
    this.producerPaused = false;
    this.currentBlock = 0;
    this.updateProgress();
    this.setMode('idle');
    this.setLabel('Listen to this article');
  }

  private async loadSettings(): Promise<void> {
    const s = await chrome.storage.local.get(['settings.voice', 'settings.speed']);
    this.voice = isKnownVoice(s['settings.voice']) ? s['settings.voice'] : DEFAULT_VOICE;
    this.speed = typeof s['settings.speed'] === 'number' ? s['settings.speed'] : 1;
  }

  private ensurePlayer(): void {
    if (this.player) return;
    this.player = new AudioPlayer();
    this.player.onChunkStart = (chunk) => {
      this.currentBlock = chunk.blockIndex;
      if (this.mode === 'loading') {
        this.setMode('playing');
        this.setLabel(this.article?.title ?? 'Playing…');
      }
      this.updateProgress();
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
          if (msg.state === 'loading') this.setLabel('Loading voice model…');
          else if (msg.state === 'error') this.setLabel(`Model error: ${msg.message ?? ''}`);
          else if (msg.backend === 'wasm') this.setLabel('Using CPU mode (slower).');
          break;
        case 'MODEL_DOWNLOAD_PROGRESS':
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
