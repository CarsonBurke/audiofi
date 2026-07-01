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

### Chatterbox ONNX / Chatterbox Turbo

Advanced experimental path, not a default. Stock
`pipeline('text-to-speech', ...)` in `@huggingface/transformers@4.2.0` still
does not instantiate `model_type: chatterbox`, but the package exports
`ChatterboxModel`, `AutoProcessor`, and `Tensor`. Resemble's official browser
demo uses those classes directly with `onnx-community/chatterbox-ONNX`, four
ONNX sessions, a model-specific dtype map, `encode_speech(...)`, and
`generate(...)`.

Why not switch immediately:
- It is materially heavier than Kokoro.
- The ONNX usage involves multiple sessions and token generation, not the
  simple `KokoroTTS.generate(text)` API.
- First load is about 1.4 GB for the browser-demo export and needs explicit
  product treatment around download size, cancellation, cache status, and
  expected latency.
- ResembleAI's `chatterbox-turbo-ONNX` repo does not currently include
  `default_voice.wav`, so Audiofi cannot use Turbo directly without a
  prompt-audio capture flow or bundled prompt voice.

Candidate role:
- Optional "expressive/local" model for users who accept a much larger first
  download than Kokoro.

Prototype status:
- `transformers-v4` is installed as an isolated package alias pointing at
  `@huggingface/transformers@4.2.0`.
- `pnpm probe:chatterbox` verifies that the alias exports `ChatterboxModel`,
  `AutoProcessor`, and `Tensor`, and checks whether the Turbo export has a
  default prompt voice.
- The probe estimates model footprint without downloading weights. Current
  `onnx-community/chatterbox-ONNX` footprint:
  - WebGPU profile: about 1.4 GB across 14 files.
  - WASM profile: about 1.4 GB across 14 files.
  - Largest assets are `speech_encoder.onnx_data` at about 563.9 MB,
    `conditional_decoder.onnx_data` at about 509.2 MB, and the quantized
    language model data at about 290.6 MB WebGPU / 337.2 MB WASM.

Implementation status:
- Audiofi exposes Chatterbox as an opt-in playable model through the isolated
  Transformers.js v4 adapter.
- The offscreen adapter mirrors the official browser demo: WebGPU uses
  `language_model: q4f16`, WASM uses `language_model: q4`, the other sessions
  use `fp32`, and the default prompt voice is encoded once then reused.
- The app's voice selector is ignored for this model until a prompt-audio or
  speaker selection UI exists.

This footprint is too large to silently download as the default article reader
voice. Keep Kokoro as default; Chatterbox remains an explicit opt-in with a
large-download warning.

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

Small 2026 candidate, but not currently exposed in Audiofi. The ONNX model card
lists StyleTTS2, 15M parameters, 24 kHz, eight voices, WebGPU/WASM runtime, and
Apache-2.0 licensing.

Important boundary: this is not stock-pipeline-compatible in
`@huggingface/transformers@4.2.0`. A direct
`pipeline('text-to-speech', 'onnx-community/KittenTTS-Nano-v0.8-ONNX')` probe
still fails because `model_type: style_text_to_speech_2` is not supported by the
text-to-audio pipeline. A custom adapter can mirror the official browser demo's
preprocessing shape: `phonemizer`, Kitten's IPA token table, `voices.npz`
parsing, and a direct `StyleTextToSpeech2Model.from_pretrained(...)` call.

Rejected adapter status:
- Model: `onnx-community/KittenTTS-Nano-v0.8-ONNX`
- Runtime tested: `transformers-v4` direct `StyleTextToSpeech2Model`.
- Extra asset: `voices.npz` (about 3.1 MB) loaded from the model repo and parsed
  in the offscreen document.
- Live extension result: not reliable. The MV3 offscreen path can reach
  `Downloading model... 100%` and then hang before model readiness. Do not
  expose it until session creation is proven end-to-end in the extension.

### Supertonic

`onnx-community/Supertonic-TTS-ONNX` also works through stock v4 with speaker
embedding files and inference-step control, but it is not a small Kokoro
replacement. It is better categorized as a larger experimental quality/control
path.

## Recommended Roadmap

1. Keep Kokoro as the default production model.
2. Add device/memory telemetry around first-load time, chunk synthesis latency,
   and backend fallback rate.
3. Keep the Chatterbox adapter experimental until it reports model size,
   estimated download, cache status, backend, and expected latency before the
   user starts playback.
4. Build separate KittenTTS, Supertonic, or Turbo adapters only if we accept
   model-specific ONNX/processor glue outside stock Transformers.js pipelines.
5. Revisit the default once Chatterbox-class quality can run within Audiofi's
   latency and memory budget on typical Chrome laptops.

## Source Notes

- Kokoro upstream: https://github.com/hexgrad/kokoro
- Chatterbox Turbo ONNX model card:
  https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX
- Official Chatterbox browser demo:
  https://github.com/resemble-ai/transformersjs-chatterbox-demo
- Chatterbox browser-demo ONNX export:
  https://huggingface.co/onnx-community/chatterbox-ONNX
- KittenTTS Nano ONNX model card:
  https://huggingface.co/onnx-community/KittenTTS-Nano-v0.8-ONNX
- Transformers.js v4 announcement:
  https://huggingface.co/blog/transformersjs-v4
