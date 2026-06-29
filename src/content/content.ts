// Content script entry point (SPEC §3.1). Injected on all pages but intentionally
// inert: it registers a single message listener and does no work — and pulls in
// no Readability code — until an EXTRACT_REQUEST arrives, at which point the
// extractor is loaded via dynamic import(). This keeps the per-page idle cost to
// a bare listener while still relying on a declared content script for reliable
// delivery.

import { onMessage, post } from '../shared/messages';
import { looksLikeArticlePage } from './article-page';

// On article-like pages, spawn the compact in-page player next to the title.
// Uses a cheap DOM heuristic (no Readability) so the idle cost stays minimal;
// the full extractor loads only when the user actually presses Play.
if (window.top === window && looksLikeArticlePage()) {
  void import('./widget').then((m) => m.mountWidget());
}

onMessage('content', async (msg) => {
  if (msg.type !== 'EXTRACT_REQUEST') return;

  // An EXTRACT_REQUEST is broadcast to every frame in the tab (the script runs
  // with all_frames). Only the top frame reports a *failure* verdict; subframes
  // stay silent unless they actually hold an article, so the SW receives exactly
  // one authoritative "not an article" signal plus a candidate from whichever
  // frame the real article lives in (often a cross-origin reader/proxy iframe).
  // The SW keeps the richest candidate — see route()'s EXTRACT_* cases.
  const isTop = window.top === window;
  const fail = (reason: 'not-article' | 'empty' | 'error', message?: string): void => {
    if (isTop) post({ to: 'sw', type: 'EXTRACT_FAILED', reason, message });
  };

  // Chrome renders PDFs in its built-in viewer with no readable DOM, but the top
  // document's `contentType` still identifies them — and it's the only MIME
  // signal available (the tabs API exposes none, so a URL not ending in `.pdf`
  // is otherwise indistinguishable from an article). Hand the URL to the panel,
  // which fetches and parses the bytes with pdf.js. Done before Readability so a
  // PDF served from any URL (e.g. arxiv.org/pdf/<id>) is caught.
  if (isTop && document.contentType === 'application/pdf') {
    post({ to: 'sw', type: 'EXTRACT_PDF', url: location.href });
    return;
  }

  try {
    const { extractArticle } = await import('./extract');

    const article = extractArticle();
    if (!article) {
      fail('not-article');
      return;
    }
    if (article.blocks.length === 0) {
      fail('empty');
      return;
    }

    // Route through the SW so it can cache the article for restore/resume
    // before forwarding to the panel (SPEC §3.2, §9: content → sw → panel).
    post({ to: 'sw', type: 'EXTRACT_RESULT', article });
  } catch (err) {
    fail('error', err instanceof Error ? err.message : String(err));
  }
});
