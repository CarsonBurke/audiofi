#!/usr/bin/env node

// Chatterbox Turbo / Transformers.js v4 prototype helper.
//
// This intentionally does not download model weights by default. It verifies
// that the isolated v4 alias exposes the APIs we need and estimates the model
// footprint from Hugging Face headers so product decisions have hard numbers.

import { AutoProcessor, ChatterboxModel, Tensor, env } from 'transformers-v4';

const MODEL_ID = 'onnx-community/chatterbox-ONNX';
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;

const COMMON_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'default_voice.wav',
  'onnx/embed_tokens.onnx',
  'onnx/embed_tokens.onnx_data',
  'onnx/speech_encoder.onnx',
  'onnx/speech_encoder.onnx_data',
  'onnx/conditional_decoder.onnx',
  'onnx/conditional_decoder.onnx_data',
];

const PROFILES = {
  webgpu: [
    ...COMMON_FILES,
    'onnx/language_model_q4f16.onnx',
    'onnx/language_model_q4f16.onnx_data',
  ],
  wasm: [
    ...COMMON_FILES,
    'onnx/language_model_q4.onnx',
    'onnx/language_model_q4.onnx_data',
  ],
};

const args = new Set(process.argv.slice(2));
const json = args.has('--json');

const api = {
  transformersVersion: env.version ?? null,
  hasChatterboxModel: typeof ChatterboxModel === 'function',
  hasAutoProcessor: typeof AutoProcessor === 'function',
  hasTensor: typeof Tensor === 'function',
};

const footprints = {};
for (const [profile, files] of Object.entries(PROFILES)) {
  footprints[profile] = await footprint(files);
}

const result = {
  modelId: MODEL_ID,
  sampleRate: 24_000,
  note: 'Footprints use HEAD Content-Length / x-linked-size. No model weights are downloaded.',
  api,
  profiles: footprints,
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Chatterbox prototype: ${MODEL_ID}`);
  console.log(`Transformers.js v4 alias: ${api.transformersVersion}`);
  console.log(
    `API: ChatterboxModel=${api.hasChatterboxModel}, AutoProcessor=${api.hasAutoProcessor}, Tensor=${api.hasTensor}`,
  );
  for (const [profile, data] of Object.entries(footprints)) {
    console.log(`\n${profile}: ${formatBytes(data.totalBytes)} across ${data.files.length} files`);
    for (const file of data.files) {
      console.log(`  ${file.path.padEnd(42)} ${formatBytes(file.bytes)}`);
    }
  }
}

async function footprint(files) {
  const rows = [];
  for (const path of files) {
    rows.push({ path, bytes: await remoteSize(path) });
  }
  return {
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    files: rows,
  };
}

async function remoteSize(path) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'HEAD',
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HEAD ${path} failed: ${res.status} ${res.statusText}`);
  }

  const linked = res.headers.get('x-linked-size');
  const length = res.headers.get('content-length');
  const raw = linked ?? length;
  const size = raw ? Number(raw) : NaN;
  if (Number.isFinite(size)) {
    return size;
  }

  if (path.startsWith('onnx/') || path.endsWith('.wav')) {
    throw new Error(`No size header for large asset ${path}`);
  }

  const body = await fetch(`${BASE}/${path}`, { redirect: 'follow' });
  if (!body.ok) {
    throw new Error(`GET ${path} failed: ${body.status} ${body.statusText}`);
  }
  return (await body.arrayBuffer()).byteLength;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
