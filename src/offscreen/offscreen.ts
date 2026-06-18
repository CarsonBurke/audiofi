// Offscreen document orchestration (SPEC §3.3, §6). Hosts the single TTS engine
// instance and runs a serial synthesis queue (one chunk at a time to bound
// VRAM/RAM), streaming each result to the panel as it is produced. Honours
// backpressure (pause when the panel's buffer is full) and seek/stop (cancel the
// in-flight run and restart from a block).

import { onMessage, post } from '../shared/messages';
import type { Block } from '../shared/types';
import { chunkBlocks } from '../content/chunk';
import { encodePcm } from '../shared/pcm';
import { TtsEngine } from './tts';

const engine = new TtsEngine();

// State for the current playback session, retained so SEEK can restart synthesis
// without the panel re-sending the article.
let blocks: Block[] = [];
let voice = 'af_heart';
let speed = 1;

// A monotonically increasing token; bumping it cancels any in-flight run loop.
let runId = 0;

// Epoch assigned by the panel for the current run; stamped on every emitted
// message so the panel can drop output from a run a later seek/stop superseded.
let epoch = 0;

// Output sink for the current run. 'panel' → post straight to the panel;
// 'content' → post to the SW, which relays to the originating tab (the offscreen
// document has no chrome.tabs to reach a content script itself).
let sink: 'panel' | 'content' = 'panel';
const outTo = (): 'panel' | 'sw' => (sink === 'content' ? 'sw' : 'panel');

// Backpressure: when paused, the loop parks on a promise until resumed/cancelled.
let paused = false;
let resumeWaiters: Array<() => void> = [];

function setPaused(value: boolean): void {
  paused = value;
  if (!value) {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

function waitWhilePaused(myRun: number): Promise<void> {
  if (!paused || myRun !== runId) return Promise.resolve();
  return new Promise((resolve) => resumeWaiters.push(resolve));
}

async function ensureEngine(): Promise<boolean> {
  if (engine.ready) return true;
  post({ to: outTo(), type: 'MODEL_STATUS', state: 'loading' });
  try {
    const backend = await engine.init((p) =>
      post({ to: outTo(), type: 'MODEL_DOWNLOAD_PROGRESS', ...p }),
    );
    post({ to: outTo(), type: 'MODEL_STATUS', state: 'ready', backend });
    return true;
  } catch (err) {
    post({
      to: outTo(),
      type: 'MODEL_STATUS',
      state: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function runSynthesis(fromBlock: number): Promise<void> {
  const myRun = ++runId;
  setPaused(false);

  if (!(await ensureEngine())) return;
  if (myRun !== runId) return; // superseded while the model loaded

  const myEpoch = epoch;
  const chunks = chunkBlocks(blocks).filter((c) => c.blockIndex >= fromBlock);
  const total = chunks.length;
  let done = 0;
  post({ to: outTo(), type: 'SYNTH_PROGRESS', epoch: myEpoch, done, total });

  let lastIndex = -1;
  for (const chunk of chunks) {
    if (myRun !== runId) return;
    await waitWhilePaused(myRun);
    if (myRun !== runId) return;

    let result;
    try {
      result = await engine.synth(chunk.text, voice, speed);
    } catch (err) {
      post({
        to: outTo(),
        type: 'ERROR',
        code: 'SYNTH_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Re-check cancellation and backpressure that may have arrived *during*
    // synthesis, so we never emit a chunk for a superseded run or overshoot a
    // pause that landed mid-synth.
    if (myRun !== runId) return;
    await waitWhilePaused(myRun);
    if (myRun !== runId) return;

    const durationMs = (result.pcm.length / result.sampleRate) * 1000;
    post({
      to: outTo(),
      type: 'SYNTH_CHUNK',
      epoch: myEpoch,
      index: chunk.index,
      blockIndex: chunk.blockIndex,
      kind: chunk.kind,
      pcm: encodePcm(result.pcm),
      sampleRate: result.sampleRate,
      durationMs,
      text: chunk.text,
    });
    lastIndex = chunk.index;
    done += 1;
    post({ to: outTo(), type: 'SYNTH_PROGRESS', epoch: myEpoch, done, total });
  }

  if (myRun === runId) {
    post({ to: outTo(), type: 'SYNTH_DONE', epoch: myEpoch, lastIndex });
  }
}

onMessage('offscreen', (msg) => {
  switch (msg.type) {
    case 'SYNTH_START':
      blocks = msg.blocks;
      voice = msg.voice;
      speed = msg.speed;
      epoch = msg.epoch;
      sink = msg.sink;
      void runSynthesis(msg.fromBlock ?? 0);
      return;

    case 'SYNTH_SEEK':
      epoch = msg.epoch;
      void runSynthesis(msg.fromBlock);
      return;

    case 'SYNTH_STOP':
      runId += 1; // cancel any in-flight loop
      setPaused(false);
      return;

    case 'SYNTH_BACKPRESSURE':
      setPaused(msg.pause);
      return;

    default:
      return;
  }
});
