import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/client',
  plugins: [
    { name: 'wintr-canonical-html-newlines', transformIndexHtml: { order: 'pre', handler: (html) => html.replace(/\r\n?/g, '\n') } },
    react(),
  ],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
