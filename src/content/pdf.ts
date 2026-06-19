// PDF text extraction (SPEC: read any article aloud — PDFs included). Chrome
// renders PDFs in a plugin with no readable DOM, so unlike the HTML path
// (extract.ts/Readability) we fetch the bytes and parse them with pdf.js. The
// output is the same {@link ExtractedArticle} shape the panel and synthesis
// pipeline already consume, so a PDF flows through unchanged from there.
//
// pdf.js needs a same-origin Web Worker; we point it at the copy bundled into
// the extension (public/pdf, synced by scripts/sync-pdf.mjs) so it stays within
// the MV3 `worker-src 'self'` CSP. pdf.js v6 no longer uses eval/Function, so it
// also stays within `script-src 'self' 'wasm-unsafe-eval'` with no extra config.
//
// The paragraph/heading reconstruction lives in the pdfjs-free pdf-blocks.ts so
// it stays unit-testable in plain Node; this module owns only the pdf.js runtime.

import * as pdfjs from 'pdfjs-dist';
import type { ExtractedArticle } from '../shared/types';
import { normalizeBlocks } from './normalize';
import { itemsToBlocks, type PdfTextItem } from './pdf-blocks';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf/pdf.worker.min.mjs');

// Guard against a pathological page count hanging the panel; a few hundred pages
// is already far beyond a typical "read this aloud" use.
const MAX_PAGES = 1000;

/** Fetch + parse a PDF into an article, or null if it has no extractable text. */
export async function pdfToArticle(
  bytes: ArrayBuffer,
  sourceUrl: string,
  fallbackTitle: string,
): Promise<ExtractedArticle | null> {
  // Load inside the try so a rejected promise (corrupt/encrypted/unreadable
  // PDF) still runs the finally and destroys the task — otherwise the worker
  // and its buffers leak. The rejection propagates to loadPdf, which surfaces a
  // "could not read this PDF" message.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  try {
    const doc = await task.promise;

    let title = fallbackTitle;
    let lang: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const info = meta.info as { Title?: string; Language?: string } | undefined;
      if (info?.Title && info.Title.trim()) title = info.Title.trim();
      if (info?.Language && info.Language.trim()) lang = info.Language.trim();
    } catch {
      // Metadata is optional; fall back to the filename-derived title.
    }

    const pages: PdfTextItem[][] = [];
    const count = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= count; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // pdf.js types items as (TextItem | TextMarkedContent)[]; the guard keeps
      // only real text items, but TS won't narrow to our local shape, so cast.
      pages.push(content.items.filter(isTextItem) as PdfTextItem[]);
      page.cleanup();
    }

    const blocks = normalizeBlocks(itemsToBlocks(pages));
    if (blocks.length === 0) return null;

    return { title, byline: null, siteName: null, lang, blocks, sourceUrl };
  } finally {
    await task.destroy();
  }
}

// pdf.js text content also yields TextMarkedContent items (no `str`); keep only
// real text items.
function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof (item as PdfTextItem).str === 'string' &&
    Array.isArray((item as PdfTextItem).transform)
  );
}
