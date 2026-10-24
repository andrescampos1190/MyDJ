// Browser end-to-end test: real backend + Vite dev server + a local media server
// serving synthesized tracks, so the full add → analyze → mix flow runs offline.
// Uses its own ports so it doesn't collide with a running dev setup.
import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";
const python =
  process.env.MYDJ_PYTHON ||
  path.join("..", "backend", "venv", isWin ? "Scripts\\python.exe" : "bin/python");
const API_PORT = 8765;
const WEB_PORT = 5175;
const MEDIA_PORT = 9765;
// A second app + backend with vocal separation on, for the stems test only (separating
// every song the other tests load would just burn CPU).
const STEMS_API_PORT = 8766;
const STEMS_WEB_PORT = 5176;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: [
    {
      // --host 0.0.0.0 like start.ps1, so the party panel's network self-check passes.
      command: `"${python}" -m uvicorn main:app --app-dir ../backend --host 0.0.0.0 --port ${API_PORT}`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: {
        ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
        MYDJ_DOWNLOAD_DIR: path.join(os.tmpdir(), "mydj-e2e-downloads"),
        MYDJ_STEMS: "0",
      },
    },
    {
      command: `"${python}" -m uvicorn main:app --app-dir ../backend --port ${STEMS_API_PORT}`,
      url: `http://127.0.0.1:${STEMS_API_PORT}/api/health`,
      env: {
        ALLOWED_ORIGINS: `http://localhost:${STEMS_WEB_PORT}`,
        MYDJ_DOWNLOAD_DIR: path.join(os.tmpdir(), "mydj-e2e-stems-downloads"),
        MYDJ_STEMS: "1",
      },
    },
    {
      command: `"${python}" ../backend/tests/serve_media.py ${MEDIA_PORT}`,
      url: `http://127.0.0.1:${MEDIA_PORT}/A_minor.mp3`,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { VITE_API_URL: `http://127.0.0.1:${API_PORT}` },
    },
    {
      command: `npx vite --port ${STEMS_WEB_PORT} --strictPort`,
      url: `http://localhost:${STEMS_WEB_PORT}`,
      env: { VITE_API_URL: `http://127.0.0.1:${STEMS_API_PORT}` },
    },
  ],
});

export { API_PORT, MEDIA_PORT, STEMS_WEB_PORT };
