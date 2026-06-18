// Chunking (SPEC §6). Sentence-level boundaries, packed up to a character budget
// tuned for ~3–8s of audio per chunk. Never split mid-sentence except when a
// single sentence exceeds the budget, in which case we fall back to clause then
// word boundaries so no text is ever lost. Headings stay in their own chunk so
// the UI can mark them (pause / tone, SPEC §3.4).

import type { Block, Chunk } from '../shared/types';

/**
 * Packing ceiling in characters. At a conversational ~14 chars/sec this keeps
 * most chunks in the 3–8s window while letting two short sentences ride together.
 * Tunable; the producer/consumer pipeline (§6) is agnostic to the exact value.
 */
export const DEFAULT_MAX_CHARS = 180;

/** Rough speaking rate used for listen-time estimates and UI display. */
export const CHARS_PER_SECOND = 14;

export interface ChunkOptions {
  maxChars?: number;
}

// Lowercased abbreviations whose trailing period must NOT end a sentence. Most
// are already expanded by normalization (§5); this is defence-in-depth for text
// that bypassed it (e.g. the harness or future callers).
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'inc', 'ltd', 'co',
  'corp', 'etc', 'no', 'vol', 'fig', 'al', 'approx', 'dept', 'univ', 'gen',
  'sen', 'rep', 'gov', 'col', 'sgt', 'capt', 'lt', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'a', 'b', 'c', 'd',
  'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's',
  't', 'u', 'v', 'w', 'x', 'y', 'z',
]);

/**
 * Split prose into sentences. Boundaries are runs of `.!?` followed by optional
 * closing quotes/brackets and whitespace (or end of string). Periods that follow
 * a known abbreviation or a single-letter initial are not treated as boundaries,
 * and decimals are skipped naturally because they have no trailing whitespace.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const boundary = /[.!?]+["'”’)\]]*(?:\s+|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const before = text.slice(start, match.index);
    const lastWord = (before.match(/(\S+)$/)?.[1] ?? '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');

    if (ABBREVIATIONS.has(lastWord)) continue; // keep scanning past this period

    const candidate = text.slice(start, end).trim();
    if (candidate) sentences.push(candidate);
    start = end;
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/**
 * Pack sentences greedily up to `maxChars`. A sentence longer than the budget is
 * flushed standalone after being hard-split on clause then word boundaries.
 */
export function packSentences(
  sentences: string[],
  maxChars: number = DEFAULT_MAX_CHARS,
): string[] {
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > maxChars) {
      flush();
      chunks.push(...hardSplit(sentence, maxChars));
      continue;
    }
    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= maxChars) {
      current += ' ' + sentence;
    } else {
      flush();
      current = sentence;
    }
  }
  flush();
  return chunks;
}

/** Split an over-long sentence on clause boundaries, then words as a last resort. */
function hardSplit(sentence: string, maxChars: number): string[] {
  const clauses = sentence.split(/(?<=[,;:—–])\s+/);
  return packGreedy(
    clauses.flatMap((c) => (c.length > maxChars ? splitWords(c, maxChars) : [c])),
    maxChars,
  );
}

function splitWords(text: string, maxChars: number): string[] {
  return packGreedy(text.split(/\s+/), maxChars);
}

/** Greedily join pieces with single spaces up to the budget (pieces kept whole). */
function packGreedy(pieces: string[], maxChars: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (!piece) continue;
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= maxChars) current += ' ' + piece;
    else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Turn an ordered, normalized block list into the synthesis chunk stream. Each
 * chunk carries the source `blockIndex` so the panel can seek by paragraph and
 * the producer can restart from a block (§6).
 */
export function chunkBlocks(blocks: Block[], opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks: Chunk[] = [];
  let index = 0;

  blocks.forEach((block, blockIndex) => {
    const text = block.text.trim();
    if (!text) return;
    const pieces = packSentences(splitSentences(text), maxChars);
    for (const piece of pieces) {
      chunks.push({ index: index++, blockIndex, kind: block.kind, text: piece });
    }
  });

  return chunks;
}

/** Estimated spoken duration of the whole article, in seconds. */
export function estimateListenSeconds(
  blocks: Block[],
  charsPerSecond: number = CHARS_PER_SECOND,
): number {
  const chars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  return Math.round(chars / charsPerSecond);
}
