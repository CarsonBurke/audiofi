// Gap-free Web Audio playback queue (SPEC §6, §3.4). Each synthesized chunk is
// scheduled as an AudioBufferSourceNode at the exact end time of the previous
// one, on a single running clock, so there is no seam between chunks. Pause/
// resume use AudioContext.suspend()/resume() (the only way to pause Web Audio
// sample-accurately); seek flushes the queue. Played buffers are dropped — only
// the small look-ahead window is retained (memory stays flat).

export interface QueuedChunk {
  index: number;
  blockIndex: number;
  kind: 'heading' | 'paragraph';
  pcm: Float32Array;
  sampleRate: number;
  durationMs: number;
  text: string;
}

export class AudioPlayer {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly sources = new Set<AudioBufferSourceNode>();

  /** ctx-clock time at which the last-scheduled chunk finishes. */
  private nextStartTime = 0;
  /** False once the producer signals SYNTH_DONE; used to detect true drain. */
  private expectMore = true;

  // Pending chunk-start notifications, fired off the *audio* clock (not wall
  // clock) so they stay accurate across suspend()/resume(): a suspended context
  // freezes ctx.currentTime, so nothing fires while paused.
  private pendingStarts: Array<{ at: number; chunk: QueuedChunk; fired: boolean }> = [];
  private ticker: ReturnType<typeof setInterval> | null = null;

  /** Chunks scheduled but not yet finished playing (drives backpressure). */
  bufferedAhead = 0;

  /** Fired (approximately) when a chunk begins audible playback. */
  onChunkStart?: (chunk: QueuedChunk) => void;
  /** Fired when a chunk finishes. */
  onChunkEnd?: (chunk: QueuedChunk) => void;
  /** Fired when the queue empties and no more chunks are expected. */
  onDrained?: () => void;

  constructor() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  get suspended(): boolean {
    return this.ctx.state === 'suspended';
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx.state === 'running') await this.ctx.suspend();
  }

  /** Schedule a chunk to play immediately after everything already queued. */
  enqueue(chunk: QueuedChunk): void {
    const buffer = this.ctx.createBuffer(1, chunk.pcm.length, chunk.sampleRate);
    // `set` avoids the ArrayBuffer-vs-ArrayBufferLike generic mismatch that
    // copyToChannel's signature imposes on a structured-cloned Float32Array.
    buffer.getChannelData(0).set(chunk.pcm);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.ctx.currentTime;
    // Small lead so the very first chunk doesn't start in the past.
    const startAt = Math.max(now + 0.02, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.sources.add(source);
    this.bufferedAhead += 1;
    this.pendingStarts.push({ at: startAt, chunk, fired: false });
    this.ensureTicker();

    source.onended = () => {
      this.sources.delete(source);
      this.pendingStarts = this.pendingStarts.filter((p) => p.chunk !== chunk);
      this.bufferedAhead -= 1;
      this.onChunkEnd?.(chunk);
      if (this.sources.size === 0 && !this.expectMore) this.onDrained?.();
      this.maybeStopTicker();
    };
  }

  private ensureTicker(): void {
    if (this.ticker === null) this.ticker = setInterval(() => this.tick(), 80);
  }

  private maybeStopTicker(): void {
    if (this.ticker !== null && this.pendingStarts.length === 0 && this.sources.size === 0) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** Fire chunk-start callbacks once the audio clock reaches each chunk's start. */
  private tick(): void {
    if (this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    for (const p of this.pendingStarts) {
      if (!p.fired && p.at <= t) {
        p.fired = true;
        this.onChunkStart?.(p.chunk);
      }
    }
    // Drop notifications that have both fired and elapsed.
    this.pendingStarts = this.pendingStarts.filter((p) => !p.fired || p.at > t - 1);
    this.maybeStopTicker();
  }

  /** Tell the player whether more chunks are coming (controls drain detection). */
  setExpectMore(value: boolean): void {
    this.expectMore = value;
    if (!value && this.sources.size === 0) this.onDrained?.();
  }

  /** Stop and discard everything queued — used by seek and stop. */
  flush(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.pendingStarts = [];
    this.bufferedAhead = 0;
    this.nextStartTime = 0;
    this.expectMore = true;
    this.maybeStopTicker();
  }

  setVolume(value: number): void {
    this.gain.gain.value = value;
  }

  async close(): Promise<void> {
    this.flush();
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.ctx.state !== 'closed') await this.ctx.close();
  }
}
