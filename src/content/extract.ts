// Article extraction (SPEC §3.1). Heuristic local extractors — no LLM (§12).
// Produces a structured, ordered Block[] that preserves paragraph and heading
// boundaries (a flat string would lose the structure the player and chunker rely
// on), then runs the normalization pass before handing the result on.

import { Readability, isProbablyReaderable } from '@mozilla/readability';
import Defuddle from 'defuddle';
import type { Block, ExtractedArticle } from '../shared/types';
import { normalizeBlocks, CODE_PLACEHOLDER, TABLE_PLACEHOLDER } from './normalize';

/** Cheap signal: is this page plausibly an article? */
export function isLikelyArticle(doc: Document = document): boolean {
  return isProbablyReaderable(doc);
}

/**
 * Extract and normalize the current document. Returns null when Readability
 * declines (not article-like). Never mutates the live document: Readability
 * rewrites its input, so we always hand it a deep clone (SPEC §3.1 step 2).
 */
export function extractArticle(
  doc: Document = document,
  sourceUrl: string = location.href,
): ExtractedArticle | null {
  const readabilityArticle = extractWithReadability(doc, sourceUrl);
  if (readabilityArticle && readabilityArticle.blocks.length > 0) {
    return readabilityArticle;
  }

  const defuddleArticle = extractWithDefuddle(doc, sourceUrl);
  if (defuddleArticle && defuddleArticle.blocks.length > 0) {
    return defuddleArticle;
  }

  return null;
}

function extractWithReadability(doc: Document, sourceUrl: string): ExtractedArticle | null {
  const clone = doc.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  if (!article || !article.content) return null;

  const blocks = normalizeBlocks(htmlToBlocks(article.content));

  return {
    title: clean(article.title) || doc.title || 'Untitled',
    byline: clean(article.byline) || null,
    siteName: clean(article.siteName) || null,
    lang: clean(article.lang) || doc.documentElement.lang || null,
    blocks,
    sourceUrl,
  };
}

function extractWithDefuddle(doc: Document, sourceUrl: string): ExtractedArticle | null {
  const clone = doc.cloneNode(true) as Document;
  const article = new Defuddle(clone, { url: sourceUrl, useAsync: false }).parse();
  if (!article.content) return null;

  const blocks = normalizeBlocks(htmlToBlocks(article.content));

  return {
    title: clean(article.title) || doc.title || 'Untitled',
    byline: clean(article.author) || null,
    siteName: clean(article.site) || clean(article.domain) || null,
    lang: clean(article.language) || doc.documentElement.lang || null,
    blocks,
    sourceUrl,
  };
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * Walk Readability's cleaned HTML into ordered blocks. Block-level elements of
 * interest are emitted in document order; non-prose (code, tables) becomes a
 * spoken placeholder rather than read-aloud garbage (SPEC §5). Unrecognized
 * containers are descended into so nested prose is not lost.
 */
export function htmlToBlocks(html: string): Block[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const blocks: Block[] = [];
  if (parsed.body.children.length === 0) {
    pushText(blocks, 'paragraph', parsed.body.textContent);
    return blocks;
  }
  walk(parsed.body, blocks);
  return blocks;
}

function walk(node: Element, out: Block[]): void {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName;
    if (HEADING_TAGS.has(tag)) {
      pushText(out, 'heading', child.textContent);
    } else if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'LI') {
      pushText(out, 'paragraph', child.textContent);
    } else if (tag === 'PRE') {
      out.push({ kind: 'paragraph', text: CODE_PLACEHOLDER });
    } else if (tag === 'TABLE') {
      out.push({ kind: 'paragraph', text: TABLE_PLACEHOLDER });
    } else if (tag === 'FIGURE') {
      const caption = child.querySelector('figcaption');
      if (caption) pushText(out, 'paragraph', caption.textContent);
    } else if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
      // skip
    } else if (child.children.length === 0) {
      pushText(out, 'paragraph', child.textContent);
    } else {
      walk(child, out); // DIV / SECTION / ARTICLE / UL / OL / … → descend
    }
  }
}

function pushText(out: Block[], kind: Block['kind'], text: string | null): void {
  const trimmed = (text ?? '').trim();
  if (trimmed) out.push({ kind, text: trimmed });
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
