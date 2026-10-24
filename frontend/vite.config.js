import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Listen on the home network too, so friends' phones can open the party page (/guest).
  server: { host: true },
})
