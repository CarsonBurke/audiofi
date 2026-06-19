# Audiofi — Chrome Web Store submission notes

Copy for the store listing and the Privacy practices tab in the developer
dashboard. Keep this in sync with `manifest.config.ts` and `privacy-policy.md`.

## Single purpose

Audiofi converts the text of a web page or PDF into spoken audio that plays on the
user's device.

## Short description

Turn any article into a spoken audiobook, fully on-device.

## Permission justifications

Paste each line into the matching field on the dashboard's Privacy practices tab.

- **offscreen** — Speech is synthesized in an offscreen document. The TTS engine
  needs Web Audio and a long-running context, which a service worker cannot provide.
- **sidePanel** — The reading view and playback controls live in the browser side
  panel.
- **activeTab** — Lets the user start reading the tab they're looking at from the
  toolbar button.
- **scripting** — Adds the in-page playback controls and reads the current page's
  text for conversion to audio.
- **storage** — Saves voice, speed, volume, and theme preferences locally, and holds
  the current session's extracted text. Cleared when the browser closes; never synced
  or transmitted.
- **host access (`<all_urls>`)** — The user can have any page they choose read aloud,
  so Audiofi needs access to the current page to extract its text. It also lets the
  panel detect and fetch PDFs that are served without a `.pdf` URL (e.g.
  `arxiv.org/pdf/<id>`). Access is exercised only when the user asks for a page to be
  read.

## Remote code

None. The runtime (the ONNX Runtime WebAssembly module) is bundled in the package and
loaded from inside the extension. The only download is the Kokoro voice model, which
is data, not executable code, and the browser caches it after the first run.

## Data use disclosures

- Personally identifiable information: **not collected.**
- Health, financial, authentication, personal communications, location: **not
  collected.**
- Web history: **not collected.**
- Website content: **used** for the extension's core function — the page text is read
  to generate audio locally. It is **not** transmitted off the device, **not** sold,
  and **not** used for anything other than playback.
- Certifications: data is not sold or transferred to third parties; data is not used
  for purposes unrelated to the extension's single purpose; data is not used to
  determine creditworthiness or for lending.

## Privacy policy URL

https://carsonburke.github.io/audiofi/ — paste into the listing's Privacy policy
field. Served by GitHub Pages from `docs/` on `main`; edit `docs/index.html` to update
it.

## Listing assets checklist

- [ ] At least one 1280×800 (or 640×400) screenshot — see `store/screenshots/`.
- [ ] 128×128 store icon (bundled at `dist/icons/icon-128.png`).
- [ ] Optional 440×280 small promo tile.
- [ ] Category and primary language.
- [ ] Detailed description.
- [x] Privacy policy URL (https://carsonburke.github.io/audiofi/).
- [ ] One-time developer registration fee paid.
