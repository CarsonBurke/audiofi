import { describe, it, expect } from 'vitest';
import {
  collapseWhitespace,
  stripCitationMarkers,
  normalizeUrlsAndHashes,
  expandAbbreviations,
  normalizeNumbersAndSymbols,
  normalizeText,
  looksLikeCode,
  normalizeBlocks,
  CODE_PLACEHOLDER,
} from '../src/content/normalize';
import type { Block } from '../src/shared/types';

describe('collapseWhitespace', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(collapseWhitespace('  a\n\n  b\t c  ')).toBe('a b c');
  });
  it('strips zero-width and soft-hyphen characters', () => {
    expect(collapseWhitespace('co­oper​ate')).toBe('cooperate');
  });
});

describe('stripCitationMarkers', () => {
  it('removes bracketed numeric citations', () => {
    expect(stripCitationMarkers('The sky is blue[1] and wide[42].')).toBe(
      'The sky is blue and wide.',
    );
  });
  it('removes editorial markers case-insensitively', () => {
    expect(stripCitationMarkers('Maybe[citation needed] true[SIC].')).toBe(
      'Maybe true.',
    );
  });
  it('removes single-letter note refs and superscripts', () => {
    expect(stripCitationMarkers('Note[a] here¹.')).toBe('Note here.');
  });
  it('keeps meaningful bracketed prose', () => {
    expect(stripCitationMarkers('He said [redacted here] loudly.')).toBe(
      'He said [redacted here] loudly.',
    );
  });
});

describe('normalizeUrlsAndHashes', () => {
  it('speaks the host and drops the path', () => {
    expect(normalizeUrlsAndHashes('See https://www.example.com/a/b?x=1 now')).toBe(
      'See example dot com now',
    );
  });
  it('handles scheme-less www hosts', () => {
    expect(normalizeUrlsAndHashes('at www.nasa.gov today')).toBe(
      'at nasa dot gov today',
    );
  });
  it('drops long opaque hashes', () => {
    expect(
      normalizeUrlsAndHashes('commit 9f8e7d6c5b4a39281706f5e4d3c2b1a0 landed'),
    ).toBe('commit  landed');
  });
  it('leaves ordinary words alone', () => {
    expect(normalizeUrlsAndHashes('a normal sentence here')).toBe(
      'a normal sentence here',
    );
  });
});

describe('expandAbbreviations', () => {
  it('expands Latin abbreviations', () => {
    expect(expandAbbreviations('Fruit, e.g., apples')).toBe(
      'Fruit, for example, apples',
    );
    expect(expandAbbreviations('CPython i.e. the reference')).toBe(
      'CPython that is, the reference',
    );
    expect(expandAbbreviations('cats, dogs, etc.')).toBe('cats, dogs, and so on');
  });
  it('expands honorifics with a following space', () => {
    expect(expandAbbreviations('Dr. Smith met Mr. Lee')).toBe(
      'Doctor Smith met Mister Lee',
    );
  });
  it('expands St. only before a capitalized word', () => {
    expect(expandAbbreviations('St. Louis')).toBe('Saint Louis');
    expect(expandAbbreviations('on Main St. now')).toBe('on Main St. now');
  });
  it('expands No. only before a number', () => {
    expect(expandAbbreviations('No. 5 wins')).toBe('Number 5 wins');
    expect(expandAbbreviations('No way')).toBe('No way');
  });
});

describe('normalizeNumbersAndSymbols', () => {
  it('speaks currency', () => {
    expect(normalizeNumbersAndSymbols('$5')).toBe('5 dollars');
    expect(normalizeNumbersAndSymbols('$1')).toBe('1 dollar');
    expect(normalizeNumbersAndSymbols('$5.50')).toBe('5 dollars and 50 cents');
    expect(normalizeNumbersAndSymbols('$0.99')).toBe('99 cents');
    expect(normalizeNumbersAndSymbols('$1,000')).toBe('1,000 dollars');
  });
  it('speaks percentages', () => {
    expect(normalizeNumbersAndSymbols('up 50%')).toBe('up 50 percent');
    expect(normalizeNumbersAndSymbols('3.5 %')).toBe('3.5 percent');
  });
  it('expands ampersands', () => {
    expect(normalizeNumbersAndSymbols('cats & dogs')).toBe('cats and dogs');
  });
});

describe('looksLikeCode', () => {
  it('flags symbol-dense source', () => {
    expect(looksLikeCode('const x = () => { return f(a[0], b.c); };')).toBe(true);
  });
  it('does not flag ordinary prose', () => {
    expect(
      looksLikeCode('This is an ordinary sentence about the weather today.'),
    ).toBe(false);
  });
});

describe('normalizeText (pipeline)', () => {
  it('composes rules and fixes punctuation spacing', () => {
    const input = 'See [1] https://www.example.com/x — e.g. $5 & more  .';
    expect(normalizeText(input)).toBe(
      'See example dot com — for example, 5 dollars and more.',
    );
  });
  it('returns empty string when nothing speakable remains', () => {
    expect(normalizeText('[1]  ')).toBe('');
  });
});

describe('normalizeBlocks', () => {
  it('drops empty blocks, swaps code, keeps headings', () => {
    const blocks: Block[] = [
      { kind: 'heading', text: 'Intro[1]' },
      { kind: 'paragraph', text: 'function f(){ return x[0]+y; } // q' },
      { kind: 'paragraph', text: '   ' },
      { kind: 'paragraph', text: 'Plain text.' },
    ];
    expect(normalizeBlocks(blocks)).toEqual([
      { kind: 'heading', text: 'Intro' },
      { kind: 'paragraph', text: CODE_PLACEHOLDER },
      { kind: 'paragraph', text: 'Plain text.' },
    ]);
  });
});
