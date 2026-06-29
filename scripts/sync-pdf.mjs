// Copy the pdf.js worker that pdfjs-dist ships in its build/ into public/pdf, so
// it is bundled into the extension and loaded from a chrome-extension:// URL at
// runtime (see src/content/pdf.ts). pdf.js spawns this worker via
// GlobalWorkerOptions.workerSrc; under MV3 a cross-origin/CDN worker would
// violate the extension's `worker-src 'self'` CSP and break offline use, so we
// point it at this same-origin copy instead.
//
// Run automatically before dev/build (package.json "predev"/"prebuild"). The
// copied worker MUST match the installed pdfjs-dist version — the worker and the
// bundled main module (build/pdf.mjs) are versioned together — so this always
// copies from node_modules rather than relying on a committed snapshot.

import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist', 'build');
const dest = join(root, 'public', 'pdf');

const FILES = ['pdf.worker.min.mjs'];

const { version } = JSON.parse(
  await readFile(join(root, 'node_modules', 'pdfjs-dist', 'package.json'), 'utf8'),
);

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
for (const file of FILES) {
  await copyFile(join(src, file), join(dest, file));
}
console.log(`[sync-pdf] copied pdf.js worker (pdfjs-dist ${version}) → public/pdf`);
