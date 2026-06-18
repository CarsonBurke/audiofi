// Content script entry point (SPEC §3.1). Injected on all pages but intentionally
// inert: it registers a single message listener and does no work — and pulls in
// no Readability code — until an EXTRACT_REQUEST arrives, at which point the
// extractor is loaded via dynamic import(). This keeps the per-page idle cost to
// a bare listener while still relying on a declared content script for reliable
// delivery.

import { onMessage, post } from '../shared/messages';

// On article-like pages, spawn the compact in-page player next to the title.
// Uses a cheap DOM heuristic (no Readability) so the idle cost stays minimal;
// the full extractor loads only when the user actually presses Play.
if (window.top === window && looksLikeArticlePage()) {
  void import('./widget').then((m) => m.mountWidget());
}

function looksLikeArticlePage(): boolean {
  if (!document.querySelector('article h1, main h1, h1')) return false;
  let textLength = 0;
  for (const p of document.querySelectorAll('article p, main p, p')) {
    textLength += p.textContent?.length ?? 0;
    if (textLength > 1200) return true;
  }
  return false;
}

onMessage('content', async (msg) => {
  if (msg.type !== 'EXTRACT_REQUEST') return;

  try {
    const { extractArticle, isLikelyArticle } = await import('./extract');

    if (!isLikelyArticle()) {
      post({ to: 'sw', type: 'EXTRACT_FAILED', reason: 'not-article' });
      return;
    }

    const article = extractArticle();
    if (!article) {
      post({ to: 'sw', type: 'EXTRACT_FAILED', reason: 'not-article' });
      return;
    }
    if (article.blocks.length === 0) {
      post({ to: 'sw', type: 'EXTRACT_FAILED', reason: 'empty' });
      return;
    }

    // Route through the SW so it can cache the article for restore/resume
    // before forwarding to the panel (SPEC §3.2, §9: content → sw → panel).
    post({ to: 'sw', type: 'EXTRACT_RESULT', article });
  } catch (err) {
    post({
      to: 'sw',
      type: 'EXTRACT_FAILED',
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
