import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Contentstack Launch serves this app from a nested path inside the
// Contentstack UI iframe, so asset URLs must be relative rather than
// absolute ("/assets/..."), hence base: './'.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    // Needed to test inside the Contentstack UI iframe via an ngrok tunnel.
    // Leading-dot entries match any subdomain, so this survives ngrok
    // rotating its free-tier subdomain on every restart.
    allowedHosts: ['.ngrok-free.app', '.ngrok.io', '.ngrok.app'],
  },
});
