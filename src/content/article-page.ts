const TITLE_SELECTOR = 'article h1, main h1, [role="article"] h1, h1';
const PROSE_SELECTOR =
  'article p, main p, [role="article"] p, p, article div, main div, [role="article"] div';

// Cheap DOM signal used only to decide whether to show the in-page widget.
// Extraction itself uses the heavier extractor stack on demand.
export function looksLikeArticlePage(doc: Document = document): boolean {
  if (!doc.querySelector(TITLE_SELECTOR)) return false;

  let textLength = 0;
  for (const el of doc.querySelectorAll<HTMLElement>(PROSE_SELECTOR)) {
    const text = cleanText(el.textContent);
    if (!isProseCandidate(el, text)) continue;

    textLength += text.length;
    if (textLength > 1200) return true;
  }

  return false;
}

function isProseCandidate(el: HTMLElement, text: string): boolean {
  if (!text) return false;
  if (el.tagName === 'P') return true;

  // Some archive/proxy pages preserve article paragraphs as styled leaf divs.
  if (el.children.length > 0 || text.length < 80) return false;

  return /[.!?]["')\]]?(?:\s|$)/.test(text);
}

function cleanText(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
