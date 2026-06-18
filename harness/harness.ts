// Manual test harness. Exercises the real content-script pipeline (Readability
// extraction → normalization → chunking) and, on demand, the real offscreen TTS
// engine + Web Audio player — all in an ordinary page so it can be driven with
// agent-browser + Chromium. Results are written to the DOM and also mirrored to
// `window.__harness` so a headless driver can assert on them via `eval`.

import { extractArticle } from '../src/content/extract';
import { chunkBlocks, estimateListenSeconds } from '../src/content/chunk';
import type { ExtractedArticle, Chunk } from '../src/shared/types';
import { TtsEngine } from '../src/offscreen/tts';
import { AudioPlayer } from '../src/panel/player';
import { DEFAULT_VOICE } from '../src/shared/voices';

const SAMPLE_HTML = `<!doctype html><html lang="en"><head><title>The Quiet Power of Local AI</title></head>
<body><article>
<h1>The Quiet Power of Local AI</h1>
<p>By Jane Doe — Example Times</p>
<p>Running models on-device used to be impractical[1]. Today, e.g. small neural
networks synthesize speech in real time, costing about $0.00 per request.</p>
<h2>Why it matters</h2>
<p>Privacy improves by 50% when no audio leaves the machine, per Dr. Smith.
See https://www.example.com/research for details[citation needed].</p>
<pre><code>const tts = await load(); tts.speak("hello");</code></pre>
<p>The approach scales from phones to laptops. It is, in short, a meaningful shift.</p>
</article></body></html>`;

interface HarnessResult {
  title: string;
  byline: string | null;
  siteName: string | null;
  blockCount: number;
  chunkCount: number;
  listenSeconds: number;
  blocks: { kind: string; text: string }[];
  chunks: { index: number; blockIndex: number; text: string }[];
  ttsBackend?: string;
  ttsChunksPlayed?: number;
  ttsError?: string;
}

declare global {
  interface Window {
    __harness?: HarnessResult;
    __ttsDone?: boolean;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const htmlInput = $('html') as HTMLTextAreaElement;
htmlInput.value = SAMPLE_HTML;

let lastArticle: ExtractedArticle | null = null;
let lastChunks: Chunk[] = [];

function setStatus(text: string): void {
  $('status').textContent = text;
}

$('extract').addEventListener('click', () => {
  setStatus('extracting…');
  const doc = new DOMParser().parseFromString(htmlInput.value, 'text/html');
  const article = extractArticle(doc, 'https://example.com/sample');
  if (!article) {
    setStatus('extraction returned null (not article-like)');
    return;
  }
  lastArticle = article;
  lastChunks = chunkBlocks(article.blocks);

  $('meta').innerHTML =
    `<strong>${article.title}</strong><br>` +
    `byline: ${article.byline ?? '—'} · site: ${article.siteName ?? '—'} · ` +
    `~${Math.round(estimateListenSeconds(article.blocks) / 60) || 1} min`;

  $('blocks').innerHTML = article.blocks
    .map((b) => `<div class="block ${b.kind}">${escapeHtml(b.text)}</div>`)
    .join('');

  $('chunk-count').textContent = String(lastChunks.length);
  $('chunks').textContent = lastChunks
    .map((c) => `#${c.index} [b${c.blockIndex} ${c.kind}] ${c.text}`)
    .join('\n');

  window.__harness = {
    title: article.title,
    byline: article.byline,
    siteName: article.siteName,
    blockCount: article.blocks.length,
    chunkCount: lastChunks.length,
    listenSeconds: estimateListenSeconds(article.blocks),
    blocks: article.blocks,
    chunks: lastChunks.map((c) => ({
      index: c.index,
      blockIndex: c.blockIndex,
      text: c.text,
    })),
  };

  (document.getElementById('synth') as HTMLButtonElement).disabled = false;
  setStatus(`extracted: ${article.blocks.length} blocks, ${lastChunks.length} chunks`);
});

$('synth').addEventListener('click', async () => {
  if (!lastChunks.length) return;
  window.__ttsDone = false;
  setStatus('loading TTS model (first run downloads weights)…');
  $('tts').textContent = 'loading model…';
  const engine = new TtsEngine();
  try {
    const backend = await engine.init((p) => {
      $('tts').textContent = `downloading ${p.file}: ${Math.round(p.progress * 100)}%`;
    });
    if (window.__harness) window.__harness.ttsBackend = backend;
    setStatus(`model ready on ${backend}; synthesizing…`);

    const player = new AudioPlayer();
    await player.resume();
    let played = 0;
    for (const chunk of lastChunks.slice(0, 2)) {
      const { pcm, sampleRate } = await engine.synth(chunk.text, DEFAULT_VOICE, 1);
      player.enqueue({
        index: chunk.index,
        blockIndex: chunk.blockIndex,
        kind: chunk.kind,
        pcm,
        sampleRate,
        durationMs: (pcm.length / sampleRate) * 1000,
        text: chunk.text,
      });
      played += 1;
      $('tts').textContent = `backend=${backend}; synthesized ${played} chunk(s), ` +
        `${pcm.length} samples @ ${sampleRate}Hz`;
    }
    player.setExpectMore(false);
    if (window.__harness) window.__harness.ttsChunksPlayed = played;
    setStatus(`done: ${played} chunk(s) on ${backend}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    $('tts').textContent = `TTS error: ${message}`;
    if (window.__harness) window.__harness.ttsError = message;
    setStatus(`TTS error: ${message}`);
  } finally {
    window.__ttsDone = true;
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
