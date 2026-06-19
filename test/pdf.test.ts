import { describe, it, expect } from 'vitest';
import { itemsToBlocks, type PdfTextItem } from '../src/content/pdf-blocks';

// Fabricate a pdf.js text item. transform is [a, b, c, d, e, f] with e = x and
// f = y (PDF origin is bottom-left, so y decreases going down the page). The
// font size is carried in `height` (and the matrix scale, which the heuristic
// ignores). `hasEOL` marks the end of a visual line.
function item(str: string, x: number, y: number, size: number, eol: boolean): PdfTextItem {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    height: size,
    width: str.length * size * 0.5,
    hasEOL: eol,
  };
}

// A whole visual line as a single end-of-line item (the common case: pdf.js
// emits one item per styled run, and the last run on a line carries hasEOL).
function line(str: string, x: number, y: number, size = 10): PdfTextItem {
  return item(str, x, y, size, true);
}

describe('itemsToBlocks — paragraph grouping by vertical gap', () => {
  it('keeps tightly-spaced lines in one paragraph and splits on a large gap', () => {
    const page: PdfTextItem[] = [
      line('The first line of a paragraph', 50, 700),
      line('continues onto a second line', 50, 688), // gap 12 < 1.5*10 → same para
      line('A separate paragraph below', 50, 656), // gap 32 > 15 → new para
    ];
    const blocks = itemsToBlocks([page]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      text: 'The first line of a paragraph continues onto a second line',
    });
    expect(blocks[1]).toEqual({ kind: 'paragraph', text: 'A separate paragraph below' });
  });

  it('starts a new paragraph on a first-line indent', () => {
    const page: PdfTextItem[] = [
      line('Body text at the left margin here', 50, 700),
      line('wrapping to the next line flush', 50, 688),
      line('Indented start of the next para', 90, 676), // +40 indent > 10*1.8
    ];
    const blocks = itemsToBlocks([page]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toBe('Indented start of the next para');
  });
});

describe('itemsToBlocks — heading detection by font size', () => {
  it('classifies a short large-font line as a heading', () => {
    const page: PdfTextItem[] = [
      line('Chapter One', 50, 700, 20), // 20 >= 1.25 * median(10) = 12.5
      line('Body text begins right here', 50, 676, 10),
      line('and runs on for a while more', 50, 664, 10),
      line('across several modest lines', 50, 652, 10),
    ];
    const blocks = itemsToBlocks([page]);
    expect(blocks[0]).toEqual({ kind: 'heading', text: 'Chapter One' });
    expect(blocks[1].kind).toBe('paragraph');
    expect(blocks[1].text).toBe(
      'Body text begins right here and runs on for a while more across several modest lines',
    );
  });

  it('does not treat a heading-sized block of >3 lines as a heading', () => {
    const big = (s: string, y: number) => line(s, 50, y, 20); // 20 >= 1.25 * 10
    const body = (s: string, y: number) => line(s, 50, y, 10); // pulls median to 10
    const page: PdfTextItem[] = [
      big('pull quote line one', 700),
      big('pull quote line two', 676),
      big('pull quote line three', 652),
      big('pull quote line four', 628), // 4 heading-sized lines → too long to be a heading
      body('regular body line a', 588),
      body('regular body line b', 576),
      body('regular body line c', 564),
      body('regular body line d', 552),
      body('regular body line e', 540),
      body('regular body line f', 528),
    ];
    const blocks = itemsToBlocks([page]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('paragraph'); // heading-sized but 4 lines long
    expect(blocks[0].text).toContain('pull quote line one');
    expect(blocks[1].kind).toBe('paragraph');
  });
});

describe('itemsToBlocks — de-hyphenation across line breaks', () => {
  it('joins a word split by a trailing ASCII hyphen without a space', () => {
    const page: PdfTextItem[] = [
      line('This is some impor-', 50, 700),
      line('tant information here', 50, 688),
    ];
    const blocks = itemsToBlocks([page]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('This is some important information here');
  });

  it('de-hyphenates a Unicode HYPHEN (U+2010), not just ASCII -', () => {
    const page: PdfTextItem[] = [
      line('an exam‐', 50, 700),
      line('ple word', 50, 688),
    ];
    expect(itemsToBlocks([page])[0].text).toBe('an example word');
  });

  it('de-hyphenates after an NFD-decomposed accented letter', () => {
    const cafe = 'cafe\u0301'; // 'café' as e + combining acute accent (U+0301)
    const page: PdfTextItem[] = [
      line(`the ${cafe}-`, 50, 700),
      line('teria menu', 50, 688),
    ];
    expect(itemsToBlocks([page])[0].text).toBe(`the ${cafe}teria menu`);
  });
});

describe('itemsToBlocks — noise removal', () => {
  it('drops bare page-number lines', () => {
    const page: PdfTextItem[] = [
      line('Some readable body content here', 50, 700),
      line('42', 300, 40), // footer page number, far below
    ];
    const blocks = itemsToBlocks([page]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Some readable body content here');
  });

  it('removes running headers repeated across pages (>=40%, >=3 pages)', () => {
    const mk = (bodyText: string): PdfTextItem[] => [
      line('ACME Quarterly Report', 50, 740), // identical running header
      line(bodyText, 50, 700),
    ];
    const blocks = itemsToBlocks([mk('Body of page one'), mk('Body of page two'), mk('Body of page three')]);
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).not.toContain('ACME Quarterly Report');
    expect(all).toContain('Body of page one');
    expect(all).toContain('Body of page three');
  });

  it('does not drop a unique single-line page as a phantom repeated header', () => {
    // A 3-page doc where page 1 is one unique line. The single line must not be
    // counted twice (as both first and last edge), which would falsely meet the
    // repeat threshold and delete it.
    const blocks = itemsToBlocks([
      [line('Unique Section Intro', 50, 700)],
      [line('Body two paragraph content', 50, 700)],
      [line('Body three paragraph content', 50, 700)],
    ]);
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).toContain('Unique Section Intro');
  });

  it('keeps a repeated edge phrase in a short doc (below the 3-page threshold)', () => {
    const mk = (bodyText: string): PdfTextItem[] => [
      line('Shared Banner', 50, 740),
      line(bodyText, 50, 700),
    ];
    const blocks = itemsToBlocks([mk('Body alpha'), mk('Body beta')]);
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).toContain('Shared Banner');
  });
});

describe('itemsToBlocks — empty input', () => {
  it('returns no blocks for a page with no text items', () => {
    expect(itemsToBlocks([[]])).toEqual([]);
    expect(itemsToBlocks([])).toEqual([]);
  });
});
