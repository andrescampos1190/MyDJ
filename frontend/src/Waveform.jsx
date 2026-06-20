import { useEffect, useRef } from "react";

// Canvas waveform with a click-to-seek surface, a played overlay, a playhead,
// and an optional cue marker. Peaks are drawn once per buffer (cheap); the
// playhead/overlay are CSS-positioned divs updated per frame (no canvas redraw).
export default function Waveform({
  buffer,
  position,
  duration,
  cue,
  intro,
  outro,
  accent = "#22d3ee",
  onSeek,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = (canvas.width = Math.max(1, canvas.offsetWidth) * 2); // retina
    const h = (canvas.height = Math.max(1, canvas.offsetHeight) * 2);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (!buffer) return;

    const data = buffer.getChannelData(0);
    const buckets = Math.min(900, Math.floor(w / 2));
    const step = Math.max(1, Math.floor(data.length / buckets));
    const stride = Math.max(1, Math.floor(step / 256)); // sample ~256 pts/bucket to catch peaks
    const mid = h / 2;
    const barW = Math.max(1, w / buckets - 1);
    ctx.fillStyle = accent;
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const start = i * step;
      const end = Math.min(data.length, start + step);
      for (let j = start; j < end; j += stride) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
      const barH = Math.max(2, peak * h * 0.92);
      ctx.fillRect((i / buckets) * w, mid - barH / 2, barW, barH);
    }
  }, [buffer, accent]);

  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const cuePct = duration && cue ? (cue / duration) * 100 : null;
  const introPct = duration && intro > 0 ? (intro / duration) * 100 : null;
  const outroPct = duration && outro > 0 && outro < duration ? (outro / duration) * 100 : null;

  return (
    <div
      className="wave"
      onClick={(e) => {
        if (!duration || !onSeek) return;
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
    >
      <canvas ref={canvasRef} className="wave-canvas" />
      <div className="wave-played" style={{ width: `${pct}%` }} />
      {introPct != null && (
        <div className="wave-intro" style={{ left: `${introPct}%` }} title="intro end (mix-in)" />
      )}
      {outroPct != null && (
        <div className="wave-outro" style={{ left: `${outroPct}%` }} title="outro start (mix-out)" />
      )}
      {cuePct != null && <div className="wave-cue" style={{ left: `${cuePct}%` }} />}
      <div className="wave-head" style={{ left: `${pct}%` }} />
    </div>
  );
}
