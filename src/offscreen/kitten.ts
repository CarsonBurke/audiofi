import type { Backend } from '../shared/types';
import type { DownloadProgress, SynthResult } from './tts';

const KITTEN_MODEL_ID = 'onnx-community/KittenTTS-Nano-v0.8-ONNX';
const KITTEN_SAMPLE_RATE = 24_000;
const MAX_INPUT_IDS = 510;
const DEFAULT_VOICE = 'Bella';
const VOICES_FILE = 'voices.npz';

const VOICE_ALIASES: Record<string, string> = {
  Bella: 'expr-voice-2-f',
  Jasper: 'expr-voice-2-m',
  Luna: 'expr-voice-3-f',
  Bruno: 'expr-voice-3-m',
  Rosie: 'expr-voice-4-f',
  Hugo: 'expr-voice-4-m',
  Kiki: 'expr-voice-5-f',
  Leo: 'expr-voice-5-m',
};

const SPEED_PRIORS: Record<string, number> = {
  'expr-voice-2-f': 0.8,
  'expr-voice-2-m': 0.8,
  'expr-voice-3-m': 0.8,
  'expr-voice-3-f': 0.8,
  'expr-voice-4-m': 0.9,
  'expr-voice-4-f': 0.8,
  'expr-voice-5-m': 0.8,
  'expr-voice-5-f': 0.8,
};

const PAD = '$';
const PUNCTUATION = ';:,.!?¡¿—…"«»"" ';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Kitten's StyleTTS2 ONNX export consumes the upstream TextCleaner IPA symbol table.
const LETTERS_IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ";

const SYMBOLS = [PAD, ...PUNCTUATION, ...LETTERS, ...LETTERS_IPA];
const CHAR_TO_INDEX = new Map(SYMBOLS.map((char, index) => [char, index]));

type TensorData = Float32Array | BigInt64Array;
type TensorLike = { data: TensorData; dims: number[] };
type TensorConstructor = new (
  dtype: 'float32' | 'int64',
  data: TensorData,
  dims: number[],
) => TensorLike;
type KittenModel = {
  (inputs: {
    input_ids: TensorLike;
    style: TensorLike;
    speed: TensorLike;
  }): Promise<{ waveform: TensorLike }>;
};
type KittenRuntime = {
  StyleTextToSpeech2Model: {
    from_pretrained(
      modelId: string,
      options: {
        device: 'cpu' | 'webgpu';
        progress_callback?: ProgressCallback;
      },
    ): Promise<KittenModel>;
  };
  Tensor: TensorConstructor;
  env: TransformersV4Env;
};
type TransformersV4Env = {
  useWasmCache?: boolean;
  backends?: { onnx?: { logLevel?: string; wasm?: { proxy?: boolean; wasmPaths?: unknown } } };
};
type ConfigureTransformersV4 = (env: TransformersV4Env, device: Backend) => void;
type ProgressCallback = ReturnType<typeof progressCallback>;
type VoiceInfo = {
  data: Float32Array;
  shape: [number, number];
};
type Phonemize = (text: string, lang?: string) => Promise<string[]>;

export class KittenTts {
  private model: KittenModel | null = null;
  private Tensor: TensorConstructor | null = null;
  private voices: Record<string, VoiceInfo> = {};
  private phonemize: Phonemize | null = null;

  constructor(private readonly configureTransformersV4: ConfigureTransformersV4) {}

  get ready(): boolean {
    return this.model !== null && this.Tensor !== null && this.phonemize !== null;
  }

  async init(device: Backend, onProgress?: (p: DownloadProgress) => void): Promise<void> {
    const [{ phonemize }, runtime] = await Promise.all([
      import('phonemizer') as Promise<{ phonemize: Phonemize }>,
      import('transformers-v4') as Promise<KittenRuntime>,
    ]);

    this.configureTransformersV4(runtime.env, device);
    this.phonemize = phonemize;
    this.Tensor = runtime.Tensor;

    const [model, voices] = await Promise.all([
      runtime.StyleTextToSpeech2Model.from_pretrained(KITTEN_MODEL_ID, {
        device: device === 'webgpu' ? 'webgpu' : 'cpu',
        progress_callback: progressCallback(onProgress),
      }),
      loadVoices(onProgress),
    ]);

    this.model = model;
    this.voices = voices;
  }

  async synth(text: string, voice: string, speed: number): Promise<SynthResult> {
    if (!this.model || !this.Tensor || !this.phonemize) {
      throw new Error('TTS engine not initialized');
    }

    const voiceId = resolveVoiceId(voice);
    const voiceData = this.voices[voiceId];
    if (!voiceData) throw new Error(`KittenTTS voice data missing: ${voiceId}`);

    const inputIds = (await this.inputIds(text)).slice(0, MAX_INPUT_IDS);
    const styleDim = voiceData.shape[1];
    const refId = Math.min(text.length, voiceData.shape[0] - 1);
    const refStyle = voiceData.data.slice(refId * styleDim, (refId + 1) * styleDim);
    const effectiveSpeed = speed * (SPEED_PRIORS[voiceId] ?? 1);

    const output = await this.model({
      input_ids: new this.Tensor(
        'int64',
        BigInt64Array.from(inputIds.map(BigInt)),
        [1, inputIds.length],
      ),
      style: new this.Tensor('float32', refStyle, [1, styleDim]),
      speed: new this.Tensor('float32', new Float32Array([effectiveSpeed]), [1]),
    });

    return { pcm: toFloat32(output.waveform.data), sampleRate: KITTEN_SAMPLE_RATE };
  }

  private async inputIds(text: string): Promise<number[]> {
    const sections = splitPunctuation(text);
    const phonemeParts = await Promise.all(
      sections.map(async (section) =>
        section.isPunctuation ? section.text : (await this.phonemize!(section.text, 'en-us')).join(' '),
      ),
    );
    const phonemeTokens = basicTokenize(phonemeParts.join(''));
    return tokenize(phonemeTokens.join(' '));
  }
}

function resolveVoiceId(voice: string): string {
  if (VOICE_ALIASES[voice]) return VOICE_ALIASES[voice];
  if (SPEED_PRIORS[voice]) return voice;
  return VOICE_ALIASES[DEFAULT_VOICE];
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

function splitPunctuation(text: string): Array<{ isPunctuation: boolean; text: string }> {
  const punctuation = /(\s*[;:,.!?¡¿—…"«»""()[\]{}]+\s*)+/g;
  const sections: Array<{ isPunctuation: boolean; text: string }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(punctuation)) {
    const index = match.index ?? 0;
    if (lastIndex < index) {
      sections.push({ isPunctuation: false, text: text.slice(lastIndex, index) });
    }
    sections.push({ isPunctuation: true, text: match[0] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    sections.push({ isPunctuation: false, text: text.slice(lastIndex) });
  }
  return sections;
}

function basicTokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

function tokenize(text: string): number[] {
  const tokens: number[] = [];
  for (const char of text) {
    const index = CHAR_TO_INDEX.get(char);
    if (index !== undefined) tokens.push(index);
  }
  tokens.unshift(0);
  tokens.push(10);
  tokens.push(0);
  return tokens;
}

async function loadVoices(onProgress?: (p: DownloadProgress) => void): Promise<Record<string, VoiceInfo>> {
  const url = `https://huggingface.co/${KITTEN_MODEL_ID}/resolve/main/${VOICES_FILE}`;
  const buffer = await fetchArrayBuffer(url, VOICES_FILE, onProgress);
  const entries = await extractZipEntries(buffer);
  const voices: Record<string, VoiceInfo> = {};

  for (const [fileName, fileData] of entries) {
    if (!fileName.endsWith('.npy')) continue;
    const { data, shape } = npyToFloat32(fileData);
    voices[fileName.replace(/\.npy$/, '')] = {
      data,
      shape: [shape[0] ?? 1, shape[1] ?? data.length],
    };
  }

  return voices;
}

async function fetchArrayBuffer(
  url: string,
  file: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load KittenTTS ${file}: ${response.status} ${response.statusText}`);
  }
  const total = Number(response.headers.get('content-length')) || 0;

  if (!onProgress || !response.body) return await response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({
      file,
      loaded,
      total,
      progress: total > 0 ? loaded / total : 0,
    });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}

function parseNpyHeader(bytes: Uint8Array): {
  descr: string;
  shape: number[];
  dataOffset: number;
} {
  if (
    bytes[0] !== 0x93 ||
    String.fromCharCode(bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]) !== 'NUMPY'
  ) {
    throw new Error('Invalid KittenTTS voice embedding file');
  }

  const majorVersion = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = majorVersion === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerOffset = majorVersion === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.slice(headerOffset, headerOffset + headerLen));
  const descr = header.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
  const shape = header
    .match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1]
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((value) => !Number.isNaN(value));

  if (!descr || !shape) throw new Error(`Invalid KittenTTS voice embedding header: ${header}`);
  return { descr, shape, dataOffset: headerOffset + headerLen };
}

function npyToFloat32(bytes: Uint8Array): { data: Float32Array; shape: number[] } {
  const { descr, shape, dataOffset } = parseNpyHeader(bytes);
  const rawBytes = bytes.slice(dataOffset);
  const aligned = new ArrayBuffer(rawBytes.length);
  new Uint8Array(aligned).set(rawBytes);

  if (descr === '<f4' || descr === 'float32') {
    return { data: new Float32Array(aligned), shape };
  }
  if (descr === '<f8' || descr === 'float64') {
    return { data: Float32Array.from(new Float64Array(aligned)), shape };
  }
  throw new Error(`Unsupported KittenTTS voice embedding dtype: ${descr}`);
}

async function extractZipEntries(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entries = new Map<string, Uint8Array>();
  let eocdOffset = -1;

  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid KittenTTS voices archive');

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);
  let cdPosition = cdOffset;
  const cdList: Array<{
    fileName: string;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    compressionMethod: number;
  }> = [];

  for (let i = 0; i < cdEntries; i += 1) {
    if (view.getUint32(cdPosition, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(cdPosition + 10, true);
    const compressedSize = view.getUint32(cdPosition + 20, true);
    const uncompressedSize = view.getUint32(cdPosition + 24, true);
    const fileNameLen = view.getUint16(cdPosition + 28, true);
    const extraLen = view.getUint16(cdPosition + 30, true);
    const commentLen = view.getUint16(cdPosition + 32, true);
    const localHeaderOffset = view.getUint32(cdPosition + 42, true);
    const fileName = new TextDecoder().decode(
      bytes.slice(cdPosition + 46, cdPosition + 46 + fileNameLen),
    );
    cdList.push({
      fileName,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      compressionMethod,
    });
    cdPosition += 46 + fileNameLen + extraLen + commentLen;
  }

  for (const entry of cdList) {
    const localOffset = entry.localHeaderOffset;
    const fileNameLen = view.getUint16(localOffset + 26, true);
    const extraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + fileNameLen + extraLen;

    if (entry.compressionMethod === 0) {
      entries.set(entry.fileName, bytes.slice(dataStart, dataStart + entry.uncompressedSize));
      continue;
    }

    if (entry.compressionMethod === 8) {
      const compressed = bytes.slice(dataStart, dataStart + entry.compressedSize);
      entries.set(entry.fileName, await inflateRaw(compressed));
    }
  }

  return entries;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const chunk = new Uint8Array(compressed.byteLength);
  chunk.set(compressed);
  await writer.write(chunk);
  await writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function toFloat32(data: TensorData): Float32Array {
  if (data instanceof Float32Array) return data;
  if (data instanceof BigInt64Array) return Float32Array.from(data, Number);
  return Float32Array.from(data);
}
