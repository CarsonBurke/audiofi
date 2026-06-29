# TTS Model Strategy, Mid-2026

Audiofi's default TTS path should remain Kokoro for now. It is not the most
expressive open model available in 2026, but it is still the best fit for the
extension's constraints: private, local, browser-runnable, fast enough to stream
article chunks, and small enough to download/cache without turning first run into
a product problem.

## Current Default

- Runtime: `kokoro-js@1.2.1`
- Model: `onnx-community/Kokoro-82M-v1.0-ONNX`
- Backend policy: WebGPU `fp32`, WASM `q8`
- Controls: voice and speed

This stack is intentionally boring: it works inside an MV3 offscreen document
with bundled ONNX Runtime WASM files and has a small enough model footprint for a
browser extension.

## 2026 Candidate Review

### Kokoro 82M

Keep as the default. Kokoro's upstream project positions the 82M model as an
efficient open-weight TTS model, and its JS path is already integrated here via
`kokoro-js`.

Strengths:
- Small model footprint relative to newer expressive TTS systems.
- Mature browser path today.
- Good enough for long-form article narration.
- Apache/open-weight posture is suitable for client-side use.

Weaknesses:
- Limited control surface: no native emotion, style, prompt-audio cloning, or
  paralinguistic tags beyond what text normalization can fake.
- Not SOTA for expressiveness in 2026.

### Chatterbox Turbo

Best next experiment, not a default yet. Resemble's Chatterbox Turbo ONNX model
is a 350M-parameter TTS model with lower compute/VRAM than their earlier models
and native paralinguistic tags such as `[laugh]`, `[chuckle]`, and `[cough]`.
It is browser/WebGPU-oriented, but stock `pipeline('text-to-speech', ...)` in
`@huggingface/transformers@4.2.0` does not instantiate it yet:
`model_type: chatterbox` is not mapped to a text-to-audio model class.

Why not switch immediately:
- It is materially heavier than Kokoro.
- The model card's ONNX usage involves multiple sessions and token generation,
  not the simple `KokoroTTS.generate(text)` API we have today.
- It would need a dedicated offscreen runtime path, download accounting, cache
  management, and real measurements on low-end devices before it is productized.

Candidate role:
- Optional "expressive/local" model after a prototype proves acceptable startup,
  memory, latency, and audio quality.

Prototype status:
- `transformers-v4` is installed as a dev-only package alias pointing at
  `@huggingface/transformers@4.2.0`.
- `pnpm probe:chatterbox` verifies that the alias exports `ChatterboxModel`,
  `AutoProcessor`, and `Tensor`.
- The probe estimates model footprint without downloading weights. Current
  `onnx-community/chatterbox-ONNX` footprint:
  - WebGPU profile: about 1.4 GB across 14 files.
  - WASM profile: about 1.4 GB across 14 files.
  - Largest assets are `speech_encoder.onnx_data` at about 563.9 MB,
    `conditional_decoder.onnx_data` at about 509.2 MB, and the quantized
    language model data at about 290.6 MB WebGPU / 337.2 MB WASM.

This footprint is too large to silently download as the default article reader
voice. It needs an explicit model choice, download estimate, cancellation, and
clear "expressive local voice" positioning.

### Transformers.js v4

Worth adopting, but not directly under the current Kokoro path yet.

Tested result in this repo:
- Upgrading root `@huggingface/transformers` from `3.8.1` to `4.2.0` installs a
  second runtime because `kokoro-js@1.2.1` depends on `@huggingface/transformers`
  `^3.5.1`.
- The build then fails because our `scripts/sync-ort.mjs` expects the v3 layout
  where both `ort-wasm-simd-threaded.jsep.mjs` and
  `ort-wasm-simd-threaded.jsep.wasm` live under the Transformers.js `dist/`
  directory. In v4, the WASM asset is supplied by `onnxruntime-web`.

Conclusion:
- Do not bump the production root dependency to v4 while Kokoro remains on
  `kokoro-js`.
- Prototype v4 in isolation for individual candidates, or migrate once Kokoro's
  JS package supports v4 natively.

### KittenTTS Nano

Best small 2026 candidate on paper, but not stock-pipeline-compatible in the
current v4 package. The ONNX model card lists StyleTTS2, 15M parameters, 24 kHz,
eight voices, WebGPU/WASM runtime, and Apache-2.0 licensing. A direct probe with
`@huggingface/transformers@4.2.0` fails before downloading weights:
`model_type: style_text_to_speech_2` is not supported by the text-to-audio
pipeline. Treat this as a custom-adapter candidate, not a drop-in library swap.

### MMS English

`Xenova/mms-tts-eng` is the small model that actually instantiates and
synthesizes through the stock Transformers.js v4 text-to-speech pipeline today.
It is a VITS model, 16 kHz, single English voice, and significantly less capable
than Kokoro. The upstream `facebook/mms-tts-eng` license is CC-BY-NC-4.0, so it
is unsuitable as Audiofi's default, but useful as a small experimental v4 path.

Probe result:
- `pipeline('text-to-speech', 'Xenova/mms-tts-eng', { device: 'cpu' })` loads.
- Short synthesis returns `Float32Array` audio at 16 kHz.
- The browser extension maps v4 `cpu` to the existing WASM fallback concept and
  bundles the matching v4 ONNX Runtime files under `public/ort-v4`.

### Supertonic

`onnx-community/Supertonic-TTS-ONNX` also works through stock v4 with speaker
embedding files and inference-step control, but it is not a small Kokoro
replacement. It is better categorized as a larger experimental quality/control
path.

## Recommended Roadmap

1. Keep Kokoro as the default production model.
2. Keep MMS English as an explicit experimental v4 path only.
3. Add device/memory telemetry around first-load time, chunk synthesis latency,
   and backend fallback rate.
4. Build separate KittenTTS and Chatterbox adapters only if we accept custom
   ONNX/phonemizer/model glue outside stock Transformers.js pipelines.
5. Ship advanced model selection only after prototypes can report model size,
   estimated download, cache status, backend, and expected latency before the
   user starts playback.
6. Revisit the default once Chatterbox-class quality can run within Audiofi's
   latency and memory budget on typical Chrome laptops.

## Source Notes

- Kokoro upstream: https://github.com/hexgrad/kokoro
- Chatterbox Turbo ONNX model card:
  https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX
- KittenTTS Nano ONNX model card:
  https://huggingface.co/onnx-community/KittenTTS-Nano-v0.8-ONNX
- MMS English model card:
  https://huggingface.co/Xenova/mms-tts-eng
- Transformers.js v4 announcement:
  https://huggingface.co/blog/transformersjs-v4
