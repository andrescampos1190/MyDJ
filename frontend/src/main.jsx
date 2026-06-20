import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// Note: no <StrictMode>. It double-invokes component bodies in dev, which would
// construct the audio Engine (and its AudioContext) twice. This app holds audio
// state in a single engine instance, so we mount it once.
createRoot(document.getElementById("root")).render(<App />);
