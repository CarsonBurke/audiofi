// TTS engine wrapper (SPEC §4). Kokoro-82M remains the default via kokoro-js.
// Experimental models can be loaded through the isolated Transformers.js v4
// alias without replacing Kokoro's v3 runtime. Backends are chosen per adapter:
// Kokoro uses WebGPU → WASM fallback; v4 "cpu" is reported as the WASM fallback.

import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import type { Backend } from '../shared/types';
import type { TtsModelId } from '../shared/tts-models';

// onnx-community fp16/fp32/q8 ONNX export that kokoro-js targets by default.
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MMS_MODEL_ID = 'Xenova/mms-tts-eng';

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
type RawAudioLike = { audio: Float32Array; sampling_rate: number };
type TextToSpeechPipeline = (
  text: string,
  options?: { speed?: number },
) => Promise<RawAudioLike>;

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
  private mms: TextToSpeechPipeline | null = null;
  private activeModel: TtsModelId | null = null;
  backend: Backend = 'wasm';

  ready(model: TtsModelId): boolean {
    return this.activeModel === model && this.adapterReady(model);
  }

  /** Load the model on the best available backend. Returns the chosen backend. */
  async init(model: TtsModelId, onProgress?: (p: DownloadProgress) => void): Promise<Backend> {
    if (this.ready(model)) return this.backend;
    if (model === 'kokoro') return await this.initKokoro(onProgress);
    if (model === 'mms-eng') return await this.initMms(onProgress);
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
    if (model === 'mms-eng') return await this.synthMms(text, speed);
    throw new Error(`Unsupported TTS model: ${model}`);
  }

  private adapterReady(model: TtsModelId): boolean {
    if (model === 'kokoro') return this.kokoro !== null;
    if (model === 'mms-eng') return this.mms !== null;
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

  private async initMms(onProgress?: (p: DownloadProgress) => void): Promise<Backend> {
    this.mms = await loadMms(onProgress);
    this.backend = 'wasm';
    this.activeModel = 'mms-eng';
    return this.backend;
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

  private async synthMms(text: string, speed: number): Promise<SynthResult> {
    if (!this.mms) throw new Error('TTS engine not initialized');
    const audio = await this.mms(text, { speed });
    return { pcm: audio.audio, sampleRate: audio.sampling_rate };
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

async function loadMms(onProgress?: (p: DownloadProgress) => void): Promise<TextToSpeechPipeline> {
  const { env: envV4, pipeline } = await import('transformers-v4');
  configureTransformersV4(envV4);
  const tts = await pipeline('text-to-speech', MMS_MODEL_ID, {
    device: 'cpu',
    progress_callback: progressCallback(onProgress),
  });
  return tts as TextToSpeechPipeline;
}

function configureTransformersV4(envV4: {
  backends?: { onnx?: { logLevel?: string; wasm?: { proxy?: boolean; wasmPaths?: unknown } } };
}): void {
  if (envV4.backends?.onnx) {
    envV4.backends.onnx.logLevel = 'error';
  }
  if (envV4.backends?.onnx?.wasm) {
    envV4.backends.onnx.wasm.proxy = false;
    envV4.backends.onnx.wasm.wasmPaths = {
      mjs: chrome.runtime.getURL('ort-v4/ort-wasm-simd-threaded.jsep.mjs'),
      wasm: chrome.runtime.getURL('ort-v4/ort-wasm-simd-threaded.jsep.wasm'),
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
