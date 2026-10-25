import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// The backend, on this computer. Phones only ever talk to the app's own port: /api is
// passed through to the backend from here, so the backend doesn't have to be reachable
// on the network (or allowed through a firewall) for friends to join a party.
const BACKEND = process.env.MYDJ_BACKEND || 'http://127.0.0.1:8000'

const proxy = {
  '/api': {
    target: BACKEND,
    // Backend not running: say so plainly (502 + backendDown) instead of a bare error.
    configure: (p) =>
      p.on('error', (_err, _req, res) => {
        if (!res.writeHead || res.headersSent) return
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: "The music server isn't running", backendDown: true }))
      }),
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Listen on the home network too, so friends' phones can open the party page (/guest).
  server: { host: true, proxy },
  preview: { host: true, proxy },
})
