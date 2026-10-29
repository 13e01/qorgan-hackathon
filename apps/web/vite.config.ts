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
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Крупные библиотеки — отдельными файлами: главная страница их не загружает, а рабочая система кэширует их
    // независимо от своего кода. Порог предупреждения о размере — стандартный (500 КБ); его превышает только
    // готовый файл maplibre-gl (≈ 1,1 МБ), который разделить нельзя, — он загружается только в рабочей системе.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
