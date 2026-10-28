import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// В разработке интерфейс на :5173, запросы /api и /ws проксируются на backend :3000 (один источник — cookie работают).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
