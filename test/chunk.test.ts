import { describe, it, expect } from 'vitest';
import {
  splitSentences,
  packSentences,
  chunkBlocks,
  estimateListenSeconds,
} from '../src/content/chunk';
import type { Block } from '../src/shared/types';

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });
  it('does not split decimals', () => {
    expect(splitSentences('Pi is 3.14 roughly.')).toEqual(['Pi is 3.14 roughly.']);
  });
  it('does not split known abbreviations', () => {
    expect(splitSentences('Dr. Smith arrived. He left.')).toEqual([
      'Dr. Smith arrived.',
      'He left.',
    ]);
  });
  it('does not split single-letter initials', () => {
    expect(splitSentences('J. R. R. Tolkien wrote it.')).toEqual([
      'J. R. R. Tolkien wrote it.',
    ]);
  });
  it('keeps closing quotes with the sentence', () => {
    expect(splitSentences('He said "go." She went.')).toEqual([
      'He said "go."',
      'She went.',
    ]);
  });
  it('returns a trailing fragment with no terminal punctuation', () => {
    expect(splitSentences('No period here')).toEqual(['No period here']);
  });
});

describe('packSentences', () => {
  it('packs multiple short sentences up to the budget', () => {
    expect(packSentences(['Aa.', 'Bb.', 'Cc.'], 8)).toEqual(['Aa. Bb.', 'Cc.']);
  });
  it('never splits a sentence that fits', () => {
    const s = 'A sentence of moderate length here.';
    expect(packSentences([s], 100)).toEqual([s]);
  });
  it('hard-splits an over-long sentence on clause boundaries', () => {
    const long = 'alpha beta, gamma delta, epsilon zeta, eta theta';
    const out = packSentences([long], 20);
    expect(out.every((c) => c.length <= 20)).toBe(true);
    expect(out.join(' ')).toBe(long);
  });
  it('falls back to word splitting when a clause exceeds the budget', () => {
    const out = packSentences(['supercalifragilistic expialidocious words'], 12);
    expect(out.join(' ')).toBe('supercalifragilistic expialidocious words');
  });
});

describe('chunkBlocks', () => {
  it('assigns monotonic indices and preserves block/kind provenance', () => {
    const blocks: Block[] = [
      { kind: 'heading', text: 'Title' },
      { kind: 'paragraph', text: 'First sentence. Second sentence.' },
    ];
    const chunks = chunkBlocks(blocks, { maxChars: 20 });
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks[0]).toMatchObject({ blockIndex: 0, kind: 'heading', text: 'Title' });
    expect(chunks[1]).toMatchObject({ blockIndex: 1, kind: 'paragraph' });
    expect(chunks[2].blockIndex).toBe(1);
  });
  it('skips empty blocks without consuming an index', () => {
    const blocks: Block[] = [
      { kind: 'paragraph', text: '  ' },
      { kind: 'paragraph', text: 'Real.' },
    ];
    const chunks = chunkBlocks(blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].blockIndex).toBe(1);
  });
});

describe('estimateListenSeconds', () => {
  it('estimates from total characters', () => {
    const blocks: Block[] = [{ kind: 'paragraph', text: 'x'.repeat(140) }];
    expect(estimateListenSeconds(blocks, 14)).toBe(10);
  });
});
