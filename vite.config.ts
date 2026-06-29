import { defineConfig, type PluginOption } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import manifest from './manifest.config';

function omitUnusedOrtWasmAsset(): PluginOption {
  return {
    name: 'audiofi:omit-unused-ort-wasm-asset',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        // tts.ts explicitly points ORT at public/ort; Vite also emits this unused fallback.
        if (/^assets\/ort-wasm-simd-threaded\.jsep-[A-Za-z0-9_-]+\.wasm$/.test(fileName)) {
          delete bundle[fileName];
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), crx({ manifest }), omitUnusedOrtWasmAsset()],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        // Offscreen document is created at runtime, not navigated to, so it is
        // not auto-discovered from the manifest — declare it as an explicit input.
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
  // onnxruntime-web ships large prebuilt WASM; don't let Vite try to optimize it.
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@huggingface/transformers', 'kokoro-js'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
