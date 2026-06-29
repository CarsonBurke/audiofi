// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { looksLikeArticlePage } from '../src/content/article-page';

function loadDocument(html: string): Document {
  document.open();
  document.write(html);
  document.close();
  return document;
}

describe('looksLikeArticlePage', () => {
  it('detects ordinary paragraph-based articles', () => {
    const paragraph =
      'This is a normal article paragraph with enough sentence text to contribute to the detector.';
    const doc = loadDocument(`
      <main>
        <h1>Readable Article</h1>
        ${Array.from({ length: 16 }, () => `<p>${paragraph}</p>`).join('')}
      </main>
    `);

    expect(looksLikeArticlePage(doc)).toBe(true);
  });

  it('detects archive pages that keep paragraphs in leaf divs', () => {
    const paragraph =
      'Chinese artificial-intelligence systems have matched the performance of leading models in some cybersecurity scenarios, pressuring policymakers and security researchers.';
    const doc = loadDocument(`
      <article>
        <h1>China Has Matched Anthropic in Cybersecurity, Resetting AI Race</h1>
        ${Array.from(
          { length: 9 },
          () => `<div style="font-family: Exchange, Georgia, serif">${paragraph}</div>`,
        ).join('')}
      </article>
    `);

    expect(doc.querySelectorAll('p')).toHaveLength(0);
    expect(looksLikeArticlePage(doc)).toBe(true);
  });

  it('does not treat a heading plus short navigation blocks as an article', () => {
    const doc = loadDocument(`
      <main>
        <h1>Products</h1>
        <div>Pricing</div>
        <div>Customers</div>
        <div>Contact sales</div>
      </main>
    `);

    expect(looksLikeArticlePage(doc)).toBe(false);
  });
});
