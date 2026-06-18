import { defineManifest } from '@crxjs/vite-plugin';

// MV3 manifest. See SPEC §8. WebGPU needs no CSP keyword; `wasm-unsafe-eval`
// is required strictly for the onnxruntime-web WASM fallback path.
//
// The cross-origin isolation keys below are valid MV3 but absent from crxjs's
// ManifestV3Options type, so the literal is cast to defineManifest's parameter
// type to admit them without `any`.
export default defineManifest({
  manifest_version: 3,
  name: 'Article → Audiobook',
  version: '0.1.0',
  description: 'Turn any article into a spoken audiobook, fully on-device.',
  minimum_chrome_version: '116',
  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: 'Read this article aloud',
    default_icon: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background/sw.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/panel/panel.html',
  },
  // Declared (not programmatically injected) so message delivery is reliable
  // under @crxjs. The script is inert until asked and lazy-imports Readability,
  // so the always-on footprint is a single idle listener (SPEC §3.1, §8 notes).
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['offscreen', 'sidePanel', 'activeTab', 'scripting', 'storage'],
  // Extraction can run on any article page.
  host_permissions: ['<all_urls>'],
  content_security_policy: {
    // MV3 extension_pages CSP only permits 'self' here (blob:/data: are
    // rejected and would make the extension fail to load). onnxruntime-web's
    // pthread workers load from the same-origin bundled .mjs, so 'self' suffices
    // for multi-threaded WASM once the page is cross-origin isolated.
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
  },
  // Make extension pages cross-origin isolated so the offscreen document can use
  // SharedArrayBuffer — onnxruntime-web then runs multi-threaded, which is the
  // difference between a usable and an unusably slow CPU/WASM fallback (the
  // WebGPU path is unaffected). `credentialless` keeps cross-origin model fetches
  // from Hugging Face working without requiring CORP headers on their responses.
  cross_origin_embedder_policy: { value: 'credentialless' },
  cross_origin_opener_policy: { value: 'same-origin' },
  // The offscreen document and its worker assets must be web-accessible so the
  // service worker can create the offscreen page and ORT can load WASM chunks.
  web_accessible_resources: [
    {
      resources: ['src/offscreen/offscreen.html', 'assets/*', 'ort/*'],
      matches: ['<all_urls>'],
    },
  ],
} as Parameters<typeof defineManifest>[0]);
