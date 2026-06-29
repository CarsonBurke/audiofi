// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { extractArticle, htmlToBlocks, isLikelyArticle } from '../src/content/extract';

const SOURCE_URL = 'https://example.com/article';

function loadDocument(html: string): Document {
  document.open();
  document.write(html);
  document.close();
  return document;
}

describe('extractArticle', () => {
  it('extracts pages that fail the cheap Mozilla readerability gate', () => {
    const paragraph =
      'Anthropic traced the activity to a Chinese artificial intelligence system used in a cybersecurity campaign. The report said the agent selected targets, wrote code, and attempted to harvest credentials with limited human direction.';
    const paragraphs = Array.from(
      { length: 8 },
      (_, i) => `<div data-testid="paragraph">${paragraph} Paragraph ${i + 1}.</div>`,
    ).join('');
    const doc = loadDocument(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Chinese AI and Cybersecurity - WSJ</title>
          <meta property="og:site_name" content="The Wall Street Journal">
        </head>
        <body>
          <main>
            <div role="article">
              <h1>Chinese AI Startup Tests Cybersecurity Boundaries</h1>
              <div class="byline">By Jane Doe</div>
              ${paragraphs}
            </div>
          </main>
        </body>
      </html>
    `);

    expect(isLikelyArticle(doc)).toBe(false);

    const article = extractArticle(doc, SOURCE_URL);

    expect(article?.title).toContain('Chinese AI');
    expect(article?.siteName).toBe('The Wall Street Journal');
    expect(article?.blocks.length).toBeGreaterThan(6);
    expect(article?.blocks[1]?.text).toContain('Anthropic traced the activity');
  });

  it('falls back to Defuddle when Readability cannot extract article content', () => {
    const articleBody =
      'First paragraph from schema body. Second paragraph has enough article text to be useful for listening. Third paragraph keeps the content substantial.';
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Schema Headline',
      articleBody,
      author: { '@type': 'Person', name: 'A Reporter' },
      publisher: { '@type': 'Organization', name: 'Example News' },
    };
    const doc = loadDocument(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Hydration Shell</title>
          <script type="application/ld+json">${JSON.stringify(schema)}</script>
        </head>
        <body><div id="root"></div></body>
      </html>
    `);

    const article = extractArticle(doc, SOURCE_URL);

    expect(article).toMatchObject({
      title: 'Schema Headline',
      byline: 'A Reporter',
      siteName: 'Example News',
      lang: 'en',
      sourceUrl: SOURCE_URL,
    });
    expect(article?.blocks).toEqual([{ kind: 'paragraph', text: articleBody }]);
  });
});

describe('htmlToBlocks', () => {
  it('keeps text-only extractor output', () => {
    expect(htmlToBlocks('A plain text article body.')).toEqual([
      { kind: 'paragraph', text: 'A plain text article body.' },
    ]);
  });
});
