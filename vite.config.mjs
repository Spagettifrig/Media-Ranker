import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the built bundle loads over file:// in the packaged app.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Bind IPv4 explicitly. Left to itself Vite listens on ::1 only, and the
    // dev script's `wait-on tcp:127.0.0.1:5173` then waits forever, so
    // Electron never launches.
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
