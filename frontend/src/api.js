// Backend base URL. Build-time configurable via VITE_API_URL (set it in production,
// e.g. https://your-backend.onrender.com). Otherwise it's this page's own server, which
// passes /api through to the backend on port 8000 (see vite.config.js) — so a friend's
// phone only needs to reach the app, never the backend directly.
export const API = import.meta.env.VITE_API_URL || "";

// For messages: where the music server is.
export const API_LABEL = API || "localhost:8000";
