// Text normalization (SPEC §5). Runs in the content script after extraction,
// before chunking. Perceived quality depends on this more than on the extractor,
// so every rule is a small, independently unit-tested function (see
// test/normalize.test.ts) and the public pipeline is a deliberate composition.
//
// Ordering matters: strip reference cruft first (so it never feeds later rules),
// expand symbols/abbreviations while sentence structure is intact, then collapse
// whitespace last.

import type { Block } from '../shared/types';

/** Placeholder spoken in place of a dropped non-prose block. */
export const CODE_PLACEHOLDER = 'Code block omitted.';
export const TABLE_PLACEHOLDER = 'Table omitted.';

/**
 * Collapse all runs of whitespace (including newlines and non-breaking spaces)
 * to single spaces, and trim. Soft hyphens and zero-width characters are dropped.
 */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/[­​-‍﻿]/g, '') // soft hyphen, zero-width
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip footnote / citation markers that would otherwise be read aloud:
 * bracketed numbers (`[1]`, `[12]`), editorial notes (`[citation needed]`,
 * `[sic]`), single-letter note refs (`[a]`), and Unicode superscript digit runs.
 * Intentionally conservative — only well-known marker shapes are removed so that
 * meaningful bracketed prose survives.
 */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(/¹|²|³|[⁰-₟]+/g, '') // superscripts/subscripts
    .replace(
      /\[\s*(?:\d{1,4}|[a-z]|citation needed|clarification needed|note|notes|sic|who\?|when\?|page needed)\s*\]/gi,
      '',
    );
}

/**
 * Replace bare URLs with their spoken host ("example dot com") and drop the
 * path, and remove long opaque hashes entirely. Reading raw URLs or hashes
 * aloud is useless noise.
 */
export function normalizeUrlsAndHashes(text: string): string {
  // Full URLs (with scheme) and scheme-less www.* hosts → spoken host only.
  const urlPattern =
    /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
  let out = text.replace(urlPattern, (match) => {
    const host = spokenHost(match);
    return host ?? '';
  });

  // Standalone long hex digests / opaque hashes (git SHAs, etc.) → drop.
  out = out.replace(/\b[0-9a-f]{16,}\b/gi, '');
  // Long mixed-case base64-ish tokens (no vowels-only words) → drop.
  out = out.replace(/\b(?=\w*\d)(?=\w*[A-Z])[A-Za-z0-9+/_-]{24,}\b/g, '');

  return out;
}

function spokenHost(url: string): string | null {
  let host = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  host = host.split(/[/?#]/)[0]; // strip path/query/fragment
  host = host.replace(/:\d+$/, ''); // strip port
  if (!host || !host.includes('.')) return null;
  return host.replace(/\./g, ' dot ');
}

// Abbreviation expansions. Ordered: multi-token Latin abbreviations first so a
// later single-token rule can't partially rewrite them. Each entry's regex is
// global + case-insensitive where safe.
const ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\betc\./gi, 'and so on'],
  [/\bvs\.?/gi, 'versus'],
  [/\bcf\./gi, 'compare'],
  [/\bet al\.?/gi, 'and others'],
  [/\bapprox\./gi, 'approximately'],
  [/\bca\.\s(?=\d)/gi, 'circa '],
  [/\bDr\.\s/g, 'Doctor '],
  [/\bMr\.\s/g, 'Mister '],
  [/\bMrs\.\s/g, 'Missus '],
  [/\bMs\.\s/g, 'Miz '],
  [/\bProf\.\s/g, 'Professor '],
  [/\bSt\.\s(?=[A-Z])/g, 'Saint '], // "St. Louis"; leaves "Main St." alone
  [/\bNo\.\s?(?=\d)/g, 'Number '], // "No. 5" → "Number 5"
];

/** Expand a curated set of common abbreviations into their spoken forms. */
export function expandAbbreviations(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ABBREVIATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Normalize the cheap, unambiguous numeric/symbol cases into spoken form:
 * currency, percentages, and the `&` ampersand. Deliberately avoids spelling
 * out arbitrary integers — modern TTS reads bare numbers well and aggressive
 * number-to-words is a rich source of errors.
 */
export function normalizeNumbersAndSymbols(text: string): string {
  let out = text;

  // Currency: $5, $5.50, $1,000, $0.99
  out = out.replace(
    /\$\s?(\d[\d,]*)(?:\.(\d{2}))?/g,
    (_m, dollarsRaw: string, centsRaw?: string) => {
      const dollars = dollarsRaw.replace(/,/g, '');
      const dollarsNum = Number(dollars);
      const cents = centsRaw ? Number(centsRaw) : 0;
      const dollarWord = dollarsNum === 1 ? 'dollar' : 'dollars';
      const centWord = cents === 1 ? 'cent' : 'cents';
      if (dollarsNum === 0 && cents > 0) return `${cents} ${centWord}`;
      if (cents > 0) return `${dollarsRaw} ${dollarWord} and ${cents} ${centWord}`;
      return `${dollarsRaw} ${dollarWord}`;
    },
  );

  // Percentages: "50%", "3.5 %"
  out = out.replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, '$1 percent');

  // Ampersand between words → "and" (keep e.g. "AT&T" readable too).
  out = out.replace(/\s&\s/g, ' and ').replace(/&/g, ' and ');

  return out;
}

/**
 * Full normalization pipeline for one prose string. Returns '' when nothing
 * speakable remains (caller drops empty blocks).
 */
export function normalizeText(text: string): string {
  let out = text;
  out = stripCitationMarkers(out);
  out = normalizeUrlsAndHashes(out);
  out = expandAbbreviations(out);
  out = normalizeNumbersAndSymbols(out);
  out = collapseWhitespace(out);
  // Tidy spacing left in front of punctuation by earlier substitutions.
  out = out.replace(/\s+([,.;:!?])/g, '$1');
  return out;
}

/**
 * Heuristic: does this paragraph look like source code or a data dump rather
 * than prose? Used to substitute a placeholder instead of reading symbol soup.
 * Triggers on high non-word-character density or many lines that look like code.
 */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) return false;
  const symbols = (trimmed.match(/[{}();=<>[\]|/\\$#@`]/g) ?? []).length;
  const density = symbols / trimmed.length;
  const hasCodeTokens = /(\bfunction\b|\bconst\b|\breturn\b|=>|;\s*$|^\s{2,}\S)/m.test(
    trimmed,
  );
  return density > 0.08 || (density > 0.04 && hasCodeTokens);
}

/**
 * Normalize an ordered block list: clean prose, swap code-like paragraphs for a
 * placeholder, mark empty results for removal. Headings are normalized but kept
 * even when short. Returns a new array (input untouched).
 */
export function normalizeBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.kind === 'paragraph' && looksLikeCode(block.text)) {
      out.push({ kind: 'paragraph', text: CODE_PLACEHOLDER });
      continue;
    }
    const text = normalizeText(block.text);
    if (!text) continue;
    out.push({ kind: block.kind, text });
  }
  return out;
}
