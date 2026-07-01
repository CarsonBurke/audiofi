const TITLE_SELECTOR = 'article h1, main h1, [role="article"] h1, h1';
const PROSE_SELECTOR =
  'article p, main p, [role="article"] p, p, article div, main div, [role="article"] div';
const MIN_HEADLINE_LENGTH = 20;

// Cheap DOM signal used only to decide whether to show the in-page widget.
// Extraction itself uses the heavier extractor stack on demand.
export function looksLikeArticlePage(doc: Document = document): boolean {
  if (!findArticleTitle(doc)) return false;

  let textLength = 0;
  for (const el of doc.querySelectorAll<HTMLElement>(PROSE_SELECTOR)) {
    const text = cleanText(el.textContent);
    if (!isProseCandidate(el, text)) continue;

    textLength += text.length;
    if (textLength > 1200) return true;
  }

  return false;
}

export function findArticleTitle(doc: Document = document): HTMLElement | null {
  const headings = Array.from(doc.querySelectorAll<HTMLElement>(TITLE_SELECTOR));
  if (headings.length === 0) return null;

  const expectedTitles = articleTitleSignals(doc);
  for (const expected of expectedTitles) {
    const match = headings.find((heading) => titleMatches(heading.textContent, expected));
    if (match) return match;
  }

  const meaningfulHeadings = headings.filter(
    (heading) => cleanText(heading.textContent).length >= MIN_HEADLINE_LENGTH,
  );
  if (meaningfulHeadings.length > 0) {
    return meaningfulHeadings.reduce((best, heading) =>
      cleanText(heading.textContent).length > cleanText(best.textContent).length ? heading : best,
    );
  }

  return headings[0] ?? null;
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

function articleTitleSignals(doc: Document): string[] {
  const signals = [
    attr(doc, 'meta[property="og:title"]', 'content'),
    attr(doc, 'meta[name="twitter:title"]', 'content'),
    doc.title,
    ...jsonLdHeadlines(doc),
  ];
  return signals
    .map(stripSiteSuffix)
    .filter((value): value is string => value.length >= MIN_HEADLINE_LENGTH);
}

function attr(doc: Document, selector: string, name: string): string {
  return cleanText(doc.querySelector(selector)?.getAttribute(name) ?? '');
}

function jsonLdHeadlines(doc: Document): string[] {
  const headlines: string[] = [];
  for (const script of doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      collectHeadlines(JSON.parse(script.textContent ?? ''), headlines);
    } catch {
      // Invalid third-party JSON-LD should not block the cheap detector.
    }
  }
  return headlines;
}

function collectHeadlines(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectHeadlines(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.headline === 'string') out.push(record.headline);
  if (record['@graph']) collectHeadlines(record['@graph'], out);
}

function stripSiteSuffix(value: string): string {
  return cleanText(value)
    .replace(/\s+\|\s+[^|]+$/u, '')
    .replace(/\s+-\s+[^-]+$/u, '');
}

function titleMatches(candidate: string | null, expected: string): boolean {
  const left = normalizeTitle(candidate);
  const right = normalizeTitle(expected);
  return (
    left.length >= MIN_HEADLINE_LENGTH &&
    right.length >= MIN_HEADLINE_LENGTH &&
    (left === right || left.includes(right) || right.includes(left))
  );
}

function normalizeTitle(value: string | null): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
