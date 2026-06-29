import { defineConfig, type PluginOption } from 'vite';
import tailwindcss from '@tailwindcss/vite';

function omitUnusedOrtWasmAsset(): PluginOption {
  return {
    name: 'audiofi:omit-unused-ort-wasm-asset',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/^assets\/ort-wasm-simd-threaded(?:\.[a-z]+)?-[A-Za-z0-9_-]+\.wasm$/.test(fileName)) {
          delete bundle[fileName];
        }
      }
    },
  };
}

// Standalone dev/build config for the manual test harness (harness/index.html).
// It deliberately omits @crxjs so the extraction → normalization → chunking →
// TTS pipeline can be exercised in an ordinary page (real WebGPU/WASM, real
// model download, no MV3 CSP), driven by agent-browser + Chromium.
export default defineConfig({
  root: 'harness',
  plugins: [tailwindcss(), omitUnusedOrtWasmAsset()],
  build: {
    target: 'esnext',
    outDir: '../dist-harness',
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@huggingface/transformers', 'transformers-v4', 'kokoro-js'],
  },
  server: {
    port: 5174,
    strictPort: true,
    // Harness lives in harness/ but imports the real modules from ../src.
    fs: { allow: ['..'] },
  },
});
