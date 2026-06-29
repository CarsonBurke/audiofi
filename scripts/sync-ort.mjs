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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const FILES = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

const V4_FILES = [
  ...FILES,
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

await copyTransformersV3Runtime();
await copyTransformersV4Runtime();

async function copyTransformersV3Runtime() {
  const src = join(root, 'node_modules', '@huggingface', 'transformers', 'dist');
  const dest = join(root, 'public', 'ort');
  const { version } = JSON.parse(
    await readFile(join(root, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8'),
  );
  await copyFiles(src, dest, FILES);
  console.log(`[sync-ort] copied ORT runtime (transformers ${version}) → public/ort`);
}

async function copyTransformersV4Runtime() {
  const transformersMain = require.resolve('transformers-v4');
  const transformersRoot = dirname(dirname(transformersMain));
  const ortPackage = await findUp(
    dirname(transformersRoot),
    join('node_modules', 'onnxruntime-web', 'package.json'),
  );
  if (!ortPackage) {
    throw new Error('Could not locate onnxruntime-web dependency for transformers-v4');
  }

  const ortRoot = dirname(ortPackage);
  const src = join(ortRoot, 'dist');
  const dest = join(root, 'public', 'ort-v4');
  const { version } = JSON.parse(await readFile(ortPackage, 'utf8'));
  await copyFiles(src, dest, V4_FILES);
  console.log(`[sync-ort] copied ORT runtime (transformers-v4 ORT ${version}) → public/ort-v4`);
}

async function copyFiles(src, dest, files) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const file of files) {
    await copyFile(join(src, file), join(dest, file));
  }
}

async function findUp(start, relativePath) {
  let dir = start;
  while (true) {
    const candidate = join(dir, relativePath);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}
