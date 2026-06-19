// Pure paragraph/heading reconstruction from pdf.js text items. Kept free of any
// pdfjs-dist or chrome import so it runs in plain Node (unit tests) and so the
// heavy pdf.js bundle is only pulled in by pdf.ts when a PDF is actually opened.

import type { Block } from '../shared/types';
import { collapseWhitespace } from './normalize';

// A pdf.js text item, narrowed to the fields the heuristic needs. Declared
// locally (not imported from pdfjs-dist) so tests can fabricate items.
export interface PdfTextItem {
  str: string;
  /** Transform matrix [a, b, c, d, e, f]; e = x, f = y (origin bottom-left). */
  transform: number[];
  height: number;
  width: number;
  hasEOL: boolean;
}

interface PdfLine {
  text: string;
  /** Font size (max glyph height on the line). */
  size: number;
  x: number;
  y: number;
  page: number;
}

/** Reconstruct paragraph/heading blocks from per-page pdf.js text items. */
export function itemsToBlocks(pages: PdfTextItem[][]): Block[] {
  const lines: PdfLine[] = [];
  pages.forEach((items, i) => itemsToLines(items, i + 1, lines));
  return linesToBlocks(lines);
}

// Group a page's items into visual lines using pdf.js's end-of-line flag.
function itemsToLines(items: PdfTextItem[], page: number, out: PdfLine[]): void {
  let buf = '';
  let size = 0;
  let x = Infinity;
  let y = 0;
  let started = false;

  const flush = (): void => {
    const text = collapseWhitespace(buf);
    if (text) out.push({ text, size, x: x === Infinity ? 0 : x, y, page });
    buf = '';
    size = 0;
    x = Infinity;
    started = false;
  };

  for (const item of items) {
    if (!started) {
      x = item.transform[4];
      y = item.transform[5];
      started = true;
    } else {
      x = Math.min(x, item.transform[4]);
    }
    size = Math.max(size, item.height);
    buf += item.str;
    if (item.hasEOL) flush();
  }
  if (started) flush();
}

/** Pure line → block grouping: paragraph breaks, headings, de-hyphenation. */
export function linesToBlocks(input: PdfLine[]): Block[] {
  const lines = dropRepeatedEdges(input).filter((l) => !isPageNumber(l.text));
  if (lines.length === 0) return [];

  const body = median(lines.map((l) => l.size)) || lines[0].size;
  const headingSize = body * 1.25;

  interface Group {
    heading: boolean;
    x: number;
    lines: PdfLine[];
  }
  const groups: Group[] = [];
  let cur: Group | null = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = i > 0 ? lines[i - 1] : null;
    const isHeading = l.size >= headingSize;

    let brk = false;
    if (!cur) {
      brk = true;
    } else if (isHeading !== cur.heading) {
      brk = true; // a heading never merges with body text
    } else if (prev && prev.page === l.page) {
      const gap = prev.y - l.y; // y decreases down the page
      const lineHeight = Math.max(prev.size, l.size);
      if (gap > 1.5 * lineHeight) brk = true;
      else if (!isHeading && l.x - cur.x > l.size * 1.8) brk = true; // first-line indent
    }
    // Across a page boundary y resets, so the gap test is meaningless — let a
    // paragraph flow across the break unless a heading switch forced a break.

    if (brk) {
      cur = { heading: isHeading, x: l.x, lines: [l] };
      groups.push(cur);
    } else {
      cur!.lines.push(l);
    }
  }

  return groups.map((g) => ({
    kind: g.heading && g.lines.length <= 3 ? 'heading' : 'paragraph',
    text: joinLines(g.lines),
  }));
}

// A line-break hyphen: ASCII '-', Unicode HYPHEN (U+2010) or non-breaking
// hyphen (U+2011), preceded by a letter (allowing a trailing combining mark, so
// NFD-decomposed accented text like "café-" still matches). PDFs encode the
// soft break with any of these glyphs.
const TRAILING_HYPHEN = /[\p{L}]\p{M}*[-‐‑]$/u;

// Join a paragraph's lines, de-hyphenating a word split across a line break
// (e.g. "infor-" + "mation" → "information").
function joinLines(lines: PdfLine[]): string {
  let text = '';
  for (const l of lines) {
    if (!text) {
      text = l.text;
    } else if (TRAILING_HYPHEN.test(text)) {
      text = text.slice(0, -1) + l.text;
    } else {
      text += ' ' + l.text;
    }
  }
  return text;
}

function isPageNumber(text: string): boolean {
  return /^\d{1,4}$/.test(text.trim());
}

// Remove running headers/footers: the first or last line of a page whose text
// repeats on a large fraction of pages (title banners, page footers). Never
// fires on a short document (threshold ≥ 2 pages, needs ≥ 3 pages to consider).
function dropRepeatedEdges(lines: PdfLine[]): PdfLine[] {
  const byPage = new Map<number, PdfLine[]>();
  for (const l of lines) {
    const arr = byPage.get(l.page);
    if (arr) arr.push(l);
    else byPage.set(l.page, [l]);
  }
  const pageCount = byPage.size;
  if (pageCount < 3) return lines;

  const edgeCounts = new Map<string, number>();
  const bump = (t: string): void => {
    edgeCounts.set(t, (edgeCounts.get(t) ?? 0) + 1);
  };
  for (const arr of byPage.values()) {
    bump(arr[0].text);
    // Guard against a single-line page counting its only line twice (which
    // could push a unique line past the repeat threshold and wrongly drop it).
    if (arr.length > 1) bump(arr[arr.length - 1].text);
  }

  const threshold = Math.max(2, Math.ceil(pageCount * 0.4));
  const repeated = new Set(
    [...edgeCounts.entries()].filter(([, n]) => n >= threshold).map(([t]) => t),
  );
  if (repeated.size === 0) return lines;

  // Drop only the edge instances (first/last line of each page) that repeat —
  // not every occurrence of the text, so a phrase that also appears mid-body
  // survives there.
  const out: PdfLine[] = [];
  for (const arr of byPage.values()) {
    arr.forEach((l, idx) => {
      const isEdge = idx === 0 || idx === arr.length - 1;
      if (isEdge && repeated.has(l.text)) return;
      out.push(l);
    });
  }
  return out;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
