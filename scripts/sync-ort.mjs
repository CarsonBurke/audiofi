// Copy the onnxruntime-web WASM runtime that @huggingface/transformers ships in
// its dist into public/ort, so it is bundled into the extension and loaded from
// a chrome-extension:// URL at runtime (see src/offscreen/tts.ts). This keeps
// inference fully on-device: by default transformers.js fetches this runtime
// from a CDN, which both violates the extension's `script-src 'self'` CSP and
// breaks offline use.
//
// Run automatically before dev/build (package.json "predev"/"prebuild"). The
// copied files MUST match the installed transformers version — its bundled glue
// (.mjs) and wasm are versioned together — so this always copies from
// node_modules rather than relying on a committed snapshot.

import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@huggingface', 'transformers', 'dist');
const dest = join(root, 'public', 'ort');

const FILES = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

const { version } = JSON.parse(
  await readFile(join(root, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8'),
);

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
for (const file of FILES) {
  await copyFile(join(src, file), join(dest, file));
}
console.log(`[sync-ort] copied ORT runtime (transformers ${version}) → public/ort`);
