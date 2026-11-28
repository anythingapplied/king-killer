import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The page and the API share one origin everywhere: in production the
    // API serves the built page, and in development Vite forwards /api (the
    // socket included) to the API on :3000. That keeps the player-profile
    // cookie same-origin and lets the API run without CORS.
    // 127.0.0.1 rather than localhost: localhost can resolve to ::1, where
    // the API isn't listening.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
})
