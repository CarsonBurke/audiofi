// Domain types shared across content script, service worker, offscreen doc,
// and side panel. See SPEC §3.1.

export type BlockKind = 'heading' | 'paragraph';

export interface Block {
  kind: BlockKind;
  text: string;
}

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  blocks: Block[];
  sourceUrl: string;
}

/** A unit of synthesis: one or more sentences packed up to the char budget. */
export interface Chunk {
  /** Monotonic index across the whole article. */
  index: number;
  /** Index of the source block this chunk was derived from. */
  blockIndex: number;
  kind: BlockKind;
  text: string;
}

export type Backend = 'webgpu' | 'wasm';

export interface VoiceOption {
  id: string;
  label: string;
  /** ISO-ish language tag, e.g. "en-us". */
  lang: string;
}

export type SessionPhase =
  | 'idle'
  | 'extracting'
  | 'synthesizing'
  | 'playing'
  | 'paused'
  | 'error';
