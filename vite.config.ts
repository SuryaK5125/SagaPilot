import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API port comes from .env (PORT). Read the file directly so a PORT variable
// meant for Vite itself (some launchers set one) can't point the proxy at Vite.
function apiPort(): string {
  try {
    const m = /^PORT=(\d+)/m.exec(fs.readFileSync('.env', 'utf8'));
    if (m) return m[1];
  } catch {
    /* no .env */
  }
  return '3001';
}

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://localhost:${apiPort()}` },
  },
});
