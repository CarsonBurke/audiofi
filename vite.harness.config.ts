import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Standalone dev/build config for the manual test harness (harness/index.html).
// It deliberately omits @crxjs so the extraction → normalization → chunking →
// TTS pipeline can be exercised in an ordinary page (real WebGPU/WASM, real
// model download, no MV3 CSP), driven by agent-browser + Chromium.
export default defineConfig({
  root: 'harness',
  plugins: [tailwindcss()],
  build: {
    target: 'esnext',
    outDir: '../dist-harness',
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@huggingface/transformers', 'kokoro-js'],
  },
  server: {
    port: 5174,
    strictPort: true,
    // Harness lives in harness/ but imports the real modules from ../src.
    fs: { allow: ['..'] },
  },
});
