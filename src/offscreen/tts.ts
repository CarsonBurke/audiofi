// TTS engine wrapper (SPEC §4). Kokoro-82M remains the default via kokoro-js.
// Experimental models can be loaded through the isolated Transformers.js v4
// alias without replacing Kokoro's v3 runtime.

import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import type { Backend } from '../shared/types';
import type { TtsModelId } from '../shared/tts-models';

// onnx-community fp16/fp32/q8 ONNX export that kokoro-js targets by default.
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const CHATTERBOX_MODEL_ID = 'onnx-community/chatterbox-ONNX';
const CHATTERBOX_DEFAULT_VOICE_URL = `https://huggingface.co/${CHATTERBOX_MODEL_ID}/resolve/main/default_voice.wav`;
const CHATTERBOX_SAMPLE_RATE = 24_000;

// Lower ONNX Runtime's environment log verbosity. This gates env-level info/
// verbose chatter, but note it does NOT silence the session-scoped WARNING
// diagnostics (e.g. "VerifyEachNodeIsAssignedToAnEp"): those are gated by the
// session's own severity, which kokoro-js gives us no way to set. Those — and
// transformers' content-length warning — are filtered at the console instead
// (see quietLibraryNoise in offscreen.ts), since Chrome maps a wasm-origin log
// to "offscreen.html:0 (anonymous function)" and lists it as an extension error.
if (env.backends?.onnx) {
  env.backends.onnx.logLevel = 'error';
}

// Run ORT-WASM inline (no proxy worker) so the strict MV3 worker-src 'self' CSP
// can't block a cross-origin/blob worker. WebGPU path is unaffected.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false;

  // CRITICAL (SPEC: fully on-device): by default transformers.js loads the ONNX
  // Runtime WASM glue module from the jsdelivr CDN. Under MV3 that fails twice —
  // the CDN import violates `script-src 'self'`, and any network dependency
  // breaks the on-device guarantee. Point ORT at the copies we bundle into the
  // extension instead (see public/ort + scripts/sync-ort.mjs, pinned to the
  // installed @huggingface/transformers version so the glue matches its wasm).
  env.backends.onnx.wasm.wasmPaths = {
    mjs: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.jsep.mjs'),
    wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.jsep.wasm'),
  };
}

type GenerateOptions = NonNullable<Parameters<KokoroTTS['generate']>[1]>;
type KokoroVoice = NonNullable<GenerateOptions['voice']>;
type TensorData = Float32Array | BigInt64Array | Int32Array | number[] | bigint[];
type TensorLike = { data: TensorData; dims: number[] };
type TensorConstructor = new (
  dtype: 'float32' | 'int64',
  data: TensorData,
  dims: number[],
) => TensorLike;
type ChatterboxSpeaker = {
  audio_features: TensorLike;
  audio_tokens: TensorLike;
  speaker_embeddings: TensorLike;
  speaker_features: TensorLike;
};
type ChatterboxModelLike = {
  encode_speech(audioValues: TensorLike): Promise<ChatterboxSpeaker>;
  generate(inputs: Record<string, unknown>): Promise<TensorLike>;
};
type ChatterboxProcessorLike = {
  _call(text: string): Promise<Record<string, unknown>>;
};
type ChatterboxRuntime = {
  AutoProcessor: {
    from_pretrained(
      modelId: string,
      options?: { progress_callback?: ReturnType<typeof progressCallback> },
    ): Promise<ChatterboxProcessorLike>;
  };
  ChatterboxModel: {
    from_pretrained(
      modelId: string,
      options: {
        device: Backend;
        dtype: ChatterboxDtypeConfig;
        progress_callback?: ReturnType<typeof progressCallback>;
      },
    ): Promise<ChatterboxModelLike>;
  };
  Tensor: TensorConstructor;
  env: Parameters<typeof configureTransformersV4>[0];
};
type TransformersV4Env = {
  useBrowserCache?: boolean;
  useWasmCache?: boolean;
  backends?: { onnx?: { logLevel?: string; wasm?: { proxy?: boolean; wasmPaths?: unknown } } };
};
type TransformersV4Options = {
  /** Disable for small v4 adapters that hang after progress reaches 100%. */
  useBrowserCache?: boolean;
};
type ChatterboxDtypeConfig = {
  embed_tokens: 'fp32';
  speech_encoder: 'fp32';
  language_model: 'q4' | 'q4f16';
  conditional_decoder: 'fp32';
};

const CHATTERBOX_DTYPE: Record<Backend, ChatterboxDtypeConfig> = {
  wasm: {
    embed_tokens: 'fp32',
    speech_encoder: 'fp32',
    language_model: 'q4',
    conditional_decoder: 'fp32',
  },
  webgpu: {
    embed_tokens: 'fp32',
    speech_encoder: 'fp32',
    language_model: 'q4f16',
    conditional_decoder: 'fp32',
  },
};

export interface SynthResult {
  /** Mono PCM in [-1, 1]. */
  pcm: Float32Array;
  sampleRate: number;
}

export interface DownloadProgress {
  file: string;
  loaded: number;
  total: number;
  /** 0–1. */
  progress: number;
}

export class TtsEngine {
  private kokoro: KokoroTTS | null = null;
  private chatterbox: ChatterboxModelLike | null = null;
  private chatterboxProcessor: ChatterboxProcessorLike | null = null;
  private chatterboxSpeaker: ChatterboxSpeaker | null = null;
  private activeModel: TtsModelId | null = null;
  backend: Backend = 'wasm';

  ready(model: TtsModelId): boolean {
    return this.activeModel === model && this.adapterReady(model);
  }

  /** Load the model on the best available backend. Returns the chosen backend. */
  async init(model: TtsModelId, onProgress?: (p: DownloadProgress) => void): Promise<Backend> {
    if (this.ready(model)) return this.backend;
    if (model === 'kokoro') return await this.initKokoro(onProgress);
    if (model === 'chatterbox-turbo') return await this.initChatterbox(onProgress);
    throw new Error(`Unsupported TTS model: ${model}`);
  }

  /** Synthesize one chunk. On Kokoro device loss mid-session, retry once on WASM. */
  async synth(
    model: TtsModelId,
    text: string,
    voice: string,
    speed: number,
  ): Promise<SynthResult> {
    if (model === 'kokoro') return await this.synthKokoro(text, voice, speed);
    if (model === 'chatterbox-turbo') return await this.synthChatterbox(text);
    throw new Error(`Unsupported TTS model: ${model}`);
  }

  private adapterReady(model: TtsModelId): boolean {
    if (model === 'kokoro') return this.kokoro !== null;
    if (model === 'chatterbox-turbo') {
      return (
        this.chatterbox !== null &&
        this.chatterboxProcessor !== null &&
        this.chatterboxSpeaker !== null
      );
    }
    return false;
  }

  private async initKokoro(onProgress?: (p: DownloadProgress) => void): Promise<Backend> {
    const wantGpu = await webgpuAvailable();
    try {
      this.kokoro = await loadKokoro(wantGpu ? 'webgpu' : 'wasm', onProgress);
      this.backend = wantGpu ? 'webgpu' : 'wasm';
      this.activeModel = 'kokoro';
    } catch (err) {
      if (!wantGpu) throw err;
      // WebGPU init failed (driver, adapter, OOM) → fall back to WASM.
      console.warn('[tts] WebGPU init failed, falling back to WASM:', err);
      this.kokoro = await loadKokoro('wasm', onProgress);
      this.backend = 'wasm';
      this.activeModel = 'kokoro';
    }
    return this.backend;
  }

  private async initChatterbox(onProgress?: (p: DownloadProgress) => void): Promise<Backend> {
    const wantGpu = await webgpuAvailable();
    try {
      await this.loadChatterbox(wantGpu ? 'webgpu' : 'wasm', onProgress);
    } catch (err) {
      if (!wantGpu) throw err;
      console.warn('[tts] Chatterbox WebGPU init failed, falling back to WASM:', err);
      await this.loadChatterbox('wasm', onProgress);
    }
    this.activeModel = 'chatterbox-turbo';
    return this.backend;
  }

  private async loadChatterbox(
    device: Backend,
    onProgress?: (p: DownloadProgress) => void,
  ): Promise<void> {
    const runtime = (await import('transformers-v4')) as unknown as ChatterboxRuntime;
    configureTransformersV4(runtime.env, device, { useBrowserCache: true });
    this.chatterboxProcessor = await runtime.AutoProcessor.from_pretrained(CHATTERBOX_MODEL_ID, {
      progress_callback: progressCallback(onProgress),
    });
    this.chatterbox = await runtime.ChatterboxModel.from_pretrained(CHATTERBOX_MODEL_ID, {
      device,
      dtype: CHATTERBOX_DTYPE[device],
      progress_callback: progressCallback(onProgress),
    });

    const voice = await loadChatterboxDefaultVoice();
    const audioValues = new runtime.Tensor('float32', voice, [1, voice.length]);
    this.chatterboxSpeaker = await this.chatterbox.encode_speech(audioValues);
    this.backend = device;
  }

  private async synthKokoro(
    text: string,
    voice: string,
    speed: number,
  ): Promise<SynthResult> {
    if (!this.kokoro) throw new Error('TTS engine not initialized');
    try {
      return await this.generateKokoro(text, voice, speed);
    } catch (err) {
      if (this.backend === 'webgpu' && isDeviceLost(err)) {
        console.warn('[tts] GPUDevice lost — falling back to WASM:', err);
        this.kokoro = await loadKokoro('wasm');
        this.backend = 'wasm';
        this.activeModel = 'kokoro';
        return await this.generateKokoro(text, voice, speed);
      }
      throw err;
    }
  }

  private async generateKokoro(
    text: string,
    voice: string,
    speed: number,
  ): Promise<SynthResult> {
    const audio = await this.kokoro!.generate(text, {
      voice: voice as KokoroVoice,
      speed,
    });
    return { pcm: audio.audio, sampleRate: audio.sampling_rate };
  }

  private async synthChatterbox(text: string): Promise<SynthResult> {
    if (!this.chatterbox || !this.chatterboxProcessor || !this.chatterboxSpeaker) {
      throw new Error('TTS engine not initialized');
    }
    const inputs = await this.chatterboxProcessor._call(text);
    const waveform = await this.chatterbox.generate({
      ...inputs,
      ...this.chatterboxSpeaker,
      exaggeration: 0.5,
      max_new_tokens: maxChatterboxTokens(text),
    });
    return { pcm: toFloat32(waveform.data), sampleRate: CHATTERBOX_SAMPLE_RATE };
  }
}

function loadKokoro(
  device: Backend,
  onProgress?: (p: DownloadProgress) => void,
): Promise<KokoroTTS> {
  return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
    device,
    progress_callback: onProgress
      ? (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
          if (p.status === 'progress') {
            onProgress({
              file: p.file ?? 'model',
              loaded: p.loaded ?? 0,
              total: p.total ?? 0,
              progress: (p.progress ?? 0) / 100,
            });
          }
        }
      : undefined,
  });
}

function configureTransformersV4(
  envV4: TransformersV4Env,
  device: Backend = 'wasm',
  options: TransformersV4Options = {},
): void {
  if (options.useBrowserCache !== undefined) {
    envV4.useBrowserCache = options.useBrowserCache;
  }
  // Transformers.js v4 preloads the ORT .mjs factory into a blob: URL when this
  // stays enabled. MV3 extension pages reject blob: scripts, so keep v4 on the
  // bundled chrome-extension:// runtime files.
  envV4.useWasmCache = false;
  if (envV4.backends?.onnx) {
    envV4.backends.onnx.logLevel = 'error';
  }
  if (envV4.backends?.onnx?.wasm) {
    envV4.backends.onnx.wasm.proxy = false;
    const variant = device === 'webgpu' ? 'jsep' : 'asyncify';
    envV4.backends.onnx.wasm.wasmPaths = {
      mjs: chrome.runtime.getURL(`ort-v4/ort-wasm-simd-threaded.${variant}.mjs`),
      wasm: chrome.runtime.getURL(`ort-v4/ort-wasm-simd-threaded.${variant}.wasm`),
    };
  }
}

function progressCallback(
  onProgress?: (p: DownloadProgress) => void,
): ((p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => void) | undefined {
  return onProgress
    ? (p) => {
        if (p.status === 'progress') {
          onProgress({
            file: p.file ?? 'model',
            loaded: p.loaded ?? 0,
            total: p.total ?? 0,
            progress: (p.progress ?? 0) / 100,
          });
        }
      }
    : undefined;
}

async function webgpuAvailable(): Promise<boolean> {
  // WebGPU lib types aren't enabled in tsconfig; probe structurally.
  const gpu = (navigator as unknown as {
    gpu?: { requestAdapter(): Promise<unknown> };
  }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

function isDeviceLost(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes('device') &&
    (message.includes('lost') ||
      message.includes('destroyed') ||
      message.includes('out of memory') ||
      message.includes('oom'))
  );
}

async function loadChatterboxDefaultVoice(): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: CHATTERBOX_SAMPLE_RATE });
  try {
    const decoded = await context.decodeAudioData(
      await fetchCachedArrayBuffer(CHATTERBOX_DEFAULT_VOICE_URL, 'Chatterbox default voice'),
    );
    return mixToMono(decoded);
  } finally {
    void context.close();
  }
}

async function fetchCachedArrayBuffer(url: string, label: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open('audiofi-tts-assets');
    const cached = await cache.match(url);
    if (cached) return await cached.arrayBuffer();
  } catch {
    cache = null;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${label}: ${response.status} ${response.statusText}`);
  }

  const clone = response.clone();
  if (cache) {
    try {
      await cache.put(url, clone);
    } catch {
      // Cache writes can fail under quota pressure; the fetched response is still usable.
    }
  }
  return await response.arrayBuffer();
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return new Float32Array(buffer.getChannelData(0));
  }

  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      mono[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return mono;
}

function toFloat32(data: TensorData): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data as ArrayLike<number>);
}

function maxChatterboxTokens(text: string): number {
  const estimated = Math.ceil((text.length / 180) * 256);
  return Math.max(128, Math.min(512, estimated));
}
