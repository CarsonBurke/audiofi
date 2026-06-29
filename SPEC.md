# Article-to-Audiobook — Browser Extension Spec

> Turn any article into a spoken audiobook, fully on-device. Heuristic article
> extraction + local neural TTS running on the GPU. No servers, no accounts,
> no audio leaving the machine.

**Status:** Draft v1 · **Target:** Chromium MV3 (Chrome/Edge/Brave/Arc) ·
**License:** TBD

---

## 1. Goals & Non-Goals

### Goals
- One click on any article page → high-quality spoken playback.
- 100% local: extraction and TTS run on-device; nothing is sent to a server.
- GPU-accelerated TTS via WebGPU, with a CPU/WASM fallback.
- Streaming synthesis — playback starts within ~1–2s, before the whole article
  is synthesized.
- Small footprint, well under 1GB: ~330MB (fp32, WebGPU) down to ~80MB
  (q8, WASM) depending on backend.
- Works offline after first-run model download.

### Non-Goals (v1)
- No paywall bypass, no infinite-scroll auto-loading, no PDF support.
- No cloud voices, no voice cloning, no accounts/sync.
- No Firefox/Safari support in v1 (Chromium-first; see §11).
- No multi-language UI (English TTS first; model permitting, expand later).
- No mobile.

---

## 2. High-Level Architecture

```
┌─────────────────┐   text    ┌──────────────────┐   chunks   ┌─────────────────────┐
│ Content Script  │ ────────▶ │  Service Worker  │ ─────────▶ │  Offscreen Document │
│ Readability.js  │           │  (orchestration, │            │  TTS inference      │
│ + normalize     │ ◀──────── │   message router)│ ◀───────── │  (WebGPU / WASM)    │
└─────────────────┘  status   └──────────────────┘  audio buf └─────────────────────┘
        ▲                              ▲                                 │
        │                              │ state                           │ audio (transferable)
        │                              ▼                                 ▼
        │                     ┌──────────────────┐            (PCM/WAV ArrayBuffer)
        └──── injected on ────│   Side Panel UI  │◀───────────────────────┘
              activation      │  player controls │   playback + queue
                              └──────────────────┘
```

**Why this split (see design rationale in §12):**
- The **service worker does not run the model** — not because of WebGPU access
  (WebGPU *is* available in service workers since Chrome 124), but because of
  **lifecycle**: a SW is killed after ~30s idle, and any single task running
  longer than **5 minutes is force-terminated**. A multi-minute streaming
  synthesis would be killed mid-run. The SW is used only as a stateless message
  router and lifecycle manager.
- The **offscreen document** has a real DOM with `navigator.gpu` and WASM, and —
  critically — a lifetime *we* control rather than the browser's idle heuristics.
  TTS is compute-only WebGPU (no canvas required). This is the established,
  documented host for in-extension ML inference (WebLLM, transformers.js samples).
- The **side panel** hosts the player UI and audio playback only. It is a *view*,
  not a durable host: the panel page **re-mounts when closed/reopened** or when
  switching to a tab where it's disabled, so the model must **not** live here —
  it would reload on every remount. UI in the panel, model in the offscreen doc.

---

## 3. Components

### 3.1 Content Script — Extraction
- **Library:** `@mozilla/readability` (the Firefox Reader View engine).
- **Flow:**
  1. On user activation (toolbar click / side-panel "Read this page"), run
     `isProbablyReaderable(document)` as a cheap gate.
  2. `const clone = document.cloneNode(true)` — **never** pass the live document
     (Readability mutates its input).
  3. `const article = new Readability(clone).parse()`.
  4. Walk `article.content` (parsed HTML) to preserve **paragraph and heading
     boundaries**; emit a structured array of blocks rather than a flat string.
  5. Run the **normalization pass** (§5).
  6. Post the normalized block list to the service worker.
- **Output shape:**
  ```ts
  type ExtractedArticle = {
    title: string;
    byline: string | null;
    siteName: string | null;
    lang: string | null;        // from <html lang> or article
    blocks: Block[];            // ordered
    sourceUrl: string;
  };
  type Block = { kind: 'heading' | 'paragraph'; text: string };
  ```
- **Failure handling:** if `parse()` returns null or `isProbablyReaderable` is
  false, surface a non-blocking "This page doesn't look like an article" state;
  optionally offer "read selection / full page text anyway".

### 3.2 Service Worker — Orchestration
- Stateless router. Holds **no** model and does **no** inference.
- Responsibilities:
  - Ensure the offscreen document exists (`chrome.offscreen.createDocument`)
    before forwarding synthesis requests; tear it down when idle. **Create it
    lazily on first synthesis request — never at SW install/startup** — to avoid
    the `clients.matchAll()` race (crbug.com/1451659) where a doc created at
    startup isn't returned. Guard with `chrome.offscreen.hasDocument()`.
  - Route messages between content script ⇄ offscreen ⇄ side panel.
  - Manage side panel open/close (`chrome.sidePanel`).
  - Track high-level session state (idle / extracting / synthesizing / playing).
- Must be resilient to its own termination: persist minimal session state to
  `chrome.storage.session` so a restart can resume.

### 3.3 Offscreen Document — TTS Inference
- Created via `chrome.offscreen.createDocument`. There is **no ML/WebGPU reason**
  in the enum — use `WORKERS` (the runtime spawns a Web Worker for ONNX/WASM) with
  an explicit `justification` string. (`DOM_PARSER` is semantically wrong; `BLOBS`
  is an acceptable alternative.) The reason is a hint, not an enforcement gate — it
  does not block WebGPU.
- Hosts the TTS runtime (§4). Receives text chunks, returns audio buffers as
  **transferable** `ArrayBuffer`s to avoid copies.
- Picks WebGPU backend if `navigator.gpu` resolves an adapter; else WASM.
- Single in-flight model instance; serial synthesis queue (one chunk at a time
  to bound VRAM/RAM).
- **Must handle `GPUDevice.lost`**: device-lost / OOM under repeated streaming
  inference is a known WebGPU failure on smaller and some AMD GPUs. On loss,
  re-acquire the device and retry, or fall back to WASM for the rest of the
  session rather than crashing playback.

### 3.4 Side Panel — UI & Playback
- `chrome.sidePanel` page. Owns the `AudioContext` and playback queue.
- Receives synthesized chunks, schedules them gap-free (Web Audio
  `AudioBufferSourceNode` scheduled on a running clock).
- Controls: play/pause, skip ¶ forward/back, speed (0.75–2×), voice select,
  scrub by paragraph, progress, current-sentence highlight (optional v1.1).

---

## 4. TTS Engine

- **Runtime:** `transformers.js` (preferred) or ONNX Runtime Web, WebGPU backend
  with WASM fallback. Production Kokoro currently stays on the
  `kokoro-js`/Transformers.js v3 stack; a direct root upgrade to
  Transformers.js v4 installs a second runtime and breaks the current ORT sync
  layout. See `docs/tts-model-strategy-2026.md`.
- **Primary model:** **Kokoro TTS** (~82M params) via `kokoro-js`, which supports
  WebGPU today (`KokoroTTS.from_pretrained(id, { device: "webgpu", dtype: "fp32" })`).
  - **Precision is backend-dependent:**
    - **WebGPU → fp32** (~330MB). Documented as the recommended dtype for WebGPU;
      quantized dtypes can be lower quality / less stable on GPU. Still far under
      the 1GB budget.
    - **WASM → q8** (~80–90MB). Quantized is fine (and preferable for size/speed)
      on the CPU path.
- **Fallback / low-end model:** **Piper** (VITS), per-voice ONNX ~20–60MB,
  fast on pure WASM. Candidate only; not currently wired into the extension UI.
- **Experimental v4 paths:** **MMS English**, **KittenTTS Nano**, and
  **Chatterbox ONNX** are exposed through the model switcher. They run through
  the isolated `transformers-v4` alias so Kokoro can remain on its stable v3
  runtime.
  - **MMS English** uses the stock v4 text-to-speech pipeline. It is small and
    useful for v4 runtime testing, but single-voice, 16 kHz, and CC-BY-NC-4.0
    upstream, so it is not a default replacement.
  - **KittenTTS Nano** uses a custom StyleTTS2 adapter because stock
    `@huggingface/transformers@4.2.0` does not support it through
    `pipeline('text-to-speech', ...)`.
  - **Chatterbox ONNX** uses the browser-demo `ChatterboxModel` API and the
    `onnx-community/chatterbox-ONNX` export with a default prompt voice.
    ResembleAI's Turbo repo remains a future prompt-audio path.
  Treat all three as experimental until startup latency, memory, download size,
  cancellation, and cache behavior are measured in the MV3 offscreen document.
  `pnpm probe:chatterbox` verifies the isolated v4 API surface and estimates the
  Chatterbox footprint without downloading weights.
- **Backend selection at runtime:**
  ```
  WebGPU adapter available?  → Kokoro on WebGPU (fp32)
  else                       → Kokoro q8 / Piper on WASM (warn: slower)
  GPUDevice lost mid-session → re-acquire, else fall back to WASM
  ```
- **Synthesis is chunked and streamed** (§6): synthesize chunk N+1 while chunk N
  plays.

---

## 5. Text Normalization

Runs in the content script after extraction, before chunking. Output quality
depends on this more than on extractor choice.

- Collapse whitespace / newlines; trim.
- Strip footnote/citation markers: `[1]`, `[citation needed]`, superscript refs.
- Expand or drop bare URLs and long hashes (don't read raw URLs aloud).
- Expand common abbreviations (`e.g.` → "for example", `Dr.`, `St.`, `No.`)
  with care around sentence-final periods.
- Normalize numbers/units/dates to spoken form where cheap and safe.
- Drop or summarize non-prose blocks (code fences, tables) — read a placeholder
  like "code block omitted" rather than garbage.
- Preserve heading text but mark it (UI may insert a pause / tone).

> Keep normalization rules in one module with unit tests; it's the most
> bug-prone surface and the highest-leverage for perceived quality.

---

## 6. Chunking & Streaming

- **Chunk boundary:** sentence-level, packed up to a max char/token budget per
  chunk (tune for ~3–8s of audio). Never split mid-sentence.
- **Pipeline:** producer (offscreen synthesis) stays 1–2 chunks ahead of the
  consumer (side panel playback). Backpressure: pause synthesis if the queue
  exceeds N buffered chunks (bounds memory).
- **Gap-free playback:** schedule each `AudioBufferSourceNode` at the precise end
  time of the previous one using `AudioContext.currentTime`.
- **Pause/seek:** pausing stops scheduling; seeking by paragraph flushes the
  queue and restarts synthesis from the target block.
- **Memory:** synthesized buffers for already-played chunks are released; only a
  small lookahead window is retained.

---

## 7. Model Management & Storage

- **Do NOT bundle the model in the extension package** (Web Store size friction,
  slow updates). Download on first run.
- **Cache:** transformers.js caches into the Cache API by default; also viable:
  OPFS or IndexedDB. After first download, fully offline.
- First-run UX: show download progress (size, %, speed), allow cancel, resume on
  next attempt. Pick voice/model before download if multiple options.
- Versioning: store model id + revision; offer re-download if a newer revision
  ships. Allow "clear model cache" in settings.
- **Storage map:**
  - `chrome.storage.local` — settings (voice, speed, model id, prefs).
  - `chrome.storage.session` — transient session/resume state.
  - Cache API / OPFS — model weights.

---

## 8. Manifest V3 Configuration

Key fields (illustrative):

```jsonc
{
  "manifest_version": 3,
  "name": "Article → Audiobook",
  "permissions": [
    "offscreen",        // TTS inference context
    "sidePanel",        // player UI
    "activeTab",        // access current page on user action
    "scripting",        // inject content script on activation
    "storage"           // settings + cache metadata
  ],
  "host_permissions": ["<all_urls>"],   // extraction on any article; justify in store listing
  "background": { "service_worker": "sw.js", "type": "module" },
  "side_panel": { "default_path": "panel.html" },
  "content_security_policy": {
    // wasm-unsafe-eval is REQUIRED for the WASM TTS fallback and is permitted in MV3.
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "action": { "default_title": "Read this article aloud" }
}
```

Notes:
- `activeTab` + `scripting` (inject on click) is preferred over a blanket
  always-on content script; less invasive, easier store review. Use
  `host_permissions: <all_urls>` only if we need pre-injection; otherwise rely on
  `activeTab`.
- WebGPU needs **no** CSP keyword. `wasm-unsafe-eval` is strictly for the WASM
  backend.
- Model weights are fetched from the model host (HF CDN, etc.) — that origin must
  be allowed by `connect-src` if we tighten CSP, and declared in the store
  listing.

---

## 9. Messaging Protocol

Typed messages over `chrome.runtime` / port connections. Sketch:

| Message                 | From → To              | Payload |
|-------------------------|------------------------|---------|
| `EXTRACT_REQUEST`       | panel → sw → content   | `{ tabId }` |
| `EXTRACT_RESULT`        | content → sw → panel   | `ExtractedArticle` |
| `SYNTH_START`           | panel → sw → offscreen | `{ blocks, voice, model }` |
| `SYNTH_CHUNK`           | offscreen → sw → panel | `{ index, audio: ArrayBuffer (transfer), durationMs }` |
| `SYNTH_PROGRESS`        | offscreen → panel      | `{ done, total }` |
| `SYNTH_BACKPRESSURE`    | panel → offscreen      | `{ pause: boolean }` |
| `SYNTH_SEEK`            | panel → offscreen      | `{ fromBlock }` |
| `MODEL_DOWNLOAD_PROGRESS` | offscreen → panel    | `{ loaded, total }` |
| `ERROR`                 | any → panel            | `{ code, message }` |

- Use a long-lived **port** for the panel ⇄ offscreen audio stream; one-off
  `sendMessage` for control.
- Audio buffers transferred (not cloned) for performance.

---

## 10. UI / UX

- **Entry:** toolbar action opens the side panel and triggers extraction of the
  active tab. Button disabled/greyed when `isProbablyReaderable` is false.
- **Reader state:** title, byline, site, estimated listen time, progress bar.
- **Controls:** play/pause, ±1 paragraph, speed slider, voice picker, stop.
- **First run:** model picker + download progress.
- **Edge states:** "not an article", "model download failed/offline",
  "WebGPU unavailable — using slower CPU mode", extraction empty.
- **Accessibility:** keyboard controls, ARIA on player, respects reduced-motion.
- **v1.1 (stretch):** current-sentence highlight synced to playback, mini-player
  in popup, queue of saved articles.

---

## 11. Browser Compatibility

- **Target:** Chromium 116+ (offscreen + sidePanel + stable WebGPU).
- **WebGPU caveats:** solid on Chrome/Edge desktop; spotty on some Linux GPU
  stacks and older hardware → **WASM fallback is mandatory**, not optional.
- **Firefox:** `chrome.offscreen` and MV3 differ; WebGPU newer. Out of scope v1;
  revisit with a separate background/worker strategy.
- **Safari:** out of scope.

---

## 12. Design Rationale (key decisions)

- **No LLM for extraction.** Heuristic Readability.js is faster, free, lossless,
  hallucination-free, and runs synchronously in the content script with access
  to the live, JS-hydrated DOM. An LLM would be slower and lossy. The *only* ML
  in the extension is TTS.
- **Offscreen doc, not service worker, for inference** — not a WebGPU-access
  issue (SWs have WebGPU since Chrome 124) but a lifecycle one: the SW is killed
  when idle and hard-capped at 5 min per task. The offscreen doc's lifetime is
  ours to control.
- **Compute-only WebGPU** — TTS needs no canvas, so an offscreen document
  suffices.
- **Stream, don't batch** — long articles must start fast and keep memory flat.
- **Download model, don't bundle** — keeps the package small and updatable.

---

## 13. Tech Stack & Build

- **Language:** TypeScript.
- **Bundler:** Vite (or esbuild) with an MV3 plugin (e.g. `@crxjs/vite-plugin`).
- **Key deps:** `@mozilla/readability`, `@huggingface/transformers` (transformers.js)
  and/or `onnxruntime-web`, `kokoro-js`, optional `piper` ONNX assets.
- **Testing:**
  - Unit: normalization + chunking modules.
  - Integration: extraction across a fixture corpus of real article HTML.
  - Manual: WebGPU vs WASM paths on at least one low-end device.
- **Lint/format:** project-standard (ESLint + Prettier).

---

## 14. Milestones

1. **M0 — Skeleton:** manifest, SW router, offscreen doc creation, side panel
   shell, message plumbing. Hello-world audio (static WAV) end to end.
2. **M1 — Extraction:** Readability + normalization + chunking; show extracted
   article in panel.
3. **M2 — TTS PoC:** Kokoro on WebGPU in offscreen doc; synthesize one paragraph
   → play. WASM fallback wired.
4. **M3 — Streaming playback:** chunk pipeline, gap-free queue, pause/seek,
   backpressure.
5. **M4 — Model management:** first-run download, cache, progress, settings.
6. **M5 — Polish:** voices, speed, edge states, a11y, store assets.
7. **M6 (stretch):** sentence highlight, saved queue, more languages/voices.

---

## 15. Open Questions / Risks

- Exact Kokoro-via-transformers.js footprint and speed inside an offscreen doc on
  mid-range GPUs — validate in M2 before committing.
- WebGPU reliability across Linux GPU stacks — measure; fallback must be genuinely
  usable, not just present.
- Web Store review friction from `<all_urls>` / broad host permissions — minimize
  by leaning on `activeTab` + on-demand injection.
- Normalization edge cases (math, code, non-Latin scripts) — bound scope for v1.
- Model hosting/CDN reliability and CSP `connect-src` for downloads.
```
