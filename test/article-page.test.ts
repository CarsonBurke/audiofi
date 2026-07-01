// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { findArticleTitle, looksLikeArticlePage } from '../src/content/article-page';

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

  it('uses article metadata to skip unrelated page h1s', () => {
    const headline =
      'At the heart of Anthropic’s clashes with the U.S. government, a decision not to play by the new rules of Trump’s Washington';
    const paragraph =
      'On Friday, OpenAI announced it was withholding the wide release of its latest AI model at the request of the U.S. government. Anthropic then faced a separate set of government actions and political attacks.';
    const doc = loadDocument(`
      <!doctype html>
      <html>
        <head>
          <title>Anthropic has bucked the rules of Trump's Washington. It's cost them. | Fortune</title>
          <meta property="og:title" content="${headline} | Fortune">
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            headline,
          })}</script>
        </head>
        <body>
          <article>
            <aside>
              <h1>Trending now</h1>
              <h1>1</h1>
              <h1>2</h1>
            </aside>
            <main>
              <h1>${headline}</h1>
              ${Array.from({ length: 8 }, () => `<p>${paragraph}</p>`).join('')}
            </main>
          </article>
        </body>
      </html>
    `);

    expect(looksLikeArticlePage(doc)).toBe(true);
    expect(findArticleTitle(doc)?.textContent).toBe(headline);
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
