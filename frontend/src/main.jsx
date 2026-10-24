import { createRoot } from "react-dom/client";
import "./index.css";

// /guest is the phone page friends open during a party session (no audio engine);
// everything else is the DJ app. Only the page being shown is loaded.
const page = window.location.pathname.startsWith("/guest")
  ? import("./Guest.jsx")
  : import("./App.jsx");

// Note: no <StrictMode>. It double-invokes component bodies in dev, which would
// construct the audio Engine (and its AudioContext) twice. This app holds audio
// state in a single engine instance, so we mount it once.
page.then(({ default: Page }) => createRoot(document.getElementById("root")).render(<Page />));
