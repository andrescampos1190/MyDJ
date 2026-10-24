// Backend base URL. Build-time configurable via VITE_API_URL (set it in production,
// e.g. https://your-backend.onrender.com). Otherwise the backend is assumed on port
// 8000 of whatever host served this page — localhost on the DJ's computer, the
// computer's Wi-Fi address on a friend's phone.
export const API =
  import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:8000`;
