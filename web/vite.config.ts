import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:2120',
      '/health': 'http://127.0.0.1:2120',
      '/setup': 'http://127.0.0.1:2120',
      '/probe': 'http://127.0.0.1:2120',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: true,
  },
});
