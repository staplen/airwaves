import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs so the same build works at / on the Pi and under /airwaves/ on the public host.
  base: './',
  plugins: [react()],
  // MapLibre loads its web worker relative to its own module; pre-bundling breaks that path.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  worker: { format: 'es' },
  server: {
    // API_TARGET=http://homeassistant.local:8090 previews local UI changes against the Pi's collector.
    proxy: { '/api': process.env.API_TARGET ?? 'http://localhost:4000' },
  },
});
