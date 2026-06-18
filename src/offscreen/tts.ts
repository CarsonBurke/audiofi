// TTS engine wrapper (SPEC §4). Kokoro-82M via kokoro-js. Backend is chosen at
// runtime: WebGPU → fp32 (recommended dtype for the GPU path) else WASM → q8
// (smaller/faster on CPU). Handles GPUDevice.lost / OOM by falling back to WASM
// for the rest of the session rather than crashing playback (§3.3).

import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import type { Backend } from '../shared/types';

// onnx-community fp16/fp32/q8 ONNX export that kokoro-js targets by default.
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

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
  private tts: KokoroTTS | null = null;
  backend: Backend = 'wasm';

  get ready(): boolean {
    return this.tts !== null;
  }

  /** Load the model on the best available backend. Returns the chosen backend. */
  async init(onProgress?: (p: DownloadProgress) => void): Promise<Backend> {
    const wantGpu = await webgpuAvailable();
    try {
      this.tts = await load(wantGpu ? 'webgpu' : 'wasm', onProgress);
      this.backend = wantGpu ? 'webgpu' : 'wasm';
    } catch (err) {
      if (!wantGpu) throw err;
      // WebGPU init failed (driver, adapter, OOM) → fall back to WASM.
      console.warn('[tts] WebGPU init failed, falling back to WASM:', err);
      this.tts = await load('wasm', onProgress);
      this.backend = 'wasm';
    }
    return this.backend;
  }

  /** Synthesize one chunk. On device loss mid-session, retry once on WASM. */
  async synth(text: string, voice: string, speed: number): Promise<SynthResult> {
    if (!this.tts) throw new Error('TTS engine not initialized');
    try {
      return await this.generate(text, voice, speed);
    } catch (err) {
      if (this.backend === 'webgpu' && isDeviceLost(err)) {
        console.warn('[tts] GPUDevice lost — falling back to WASM:', err);
        this.tts = await load('wasm');
        this.backend = 'wasm';
        return await this.generate(text, voice, speed);
      }
      throw err;
    }
  }

  private async generate(
    text: string,
    voice: string,
    speed: number,
  ): Promise<SynthResult> {
    const audio = await this.tts!.generate(text, {
      voice: voice as KokoroVoice,
      speed,
    });
    return { pcm: audio.audio, sampleRate: audio.sampling_rate };
  }
}

function load(
  device: Backend,
  onProgress?: (p: DownloadProgress) => void,
): Promise<KokoroTTS> {
  return KokoroTTS.from_pretrained(MODEL_ID, {
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
