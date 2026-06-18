import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [tailwindcss(), crx({ manifest })],
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
