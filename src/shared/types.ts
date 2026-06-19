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

/**
 * The shared playback mode mirrored across the side panel and the in-page widget
 * when they act as views of one session. A subset of each surface's local `Mode`
 * (the panel also has a private 'error'); 'idle' over the wire means the session
 * has ended. See {@link import('./messages').SessionSync}.
 */
export type SessionMode = 'idle' | 'loading' | 'playing' | 'paused' | 'done';
