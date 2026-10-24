import { useState } from "react";
import "./Art.css";

// A song's artwork: its thumbnail, or a colored tile derived from its title.
export default function Art({ track, size = 48 }) {
  const [broken, setBroken] = useState(false);
  const title = track?.title || "";
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 360;
  const style = { width: size, height: size };
  if (track?.thumbnail && !broken)
    return (
      <img className="art" style={style} src={track.thumbnail} alt="" onError={() => setBroken(true)} />
    );
  return (
    <div
      className="art art-fallback"
      style={{
        ...style,
        background: `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 60) % 360} 70% 30%))`,
      }}
    >
      <span style={{ fontSize: size * 0.4 }}>♪</span>
    </div>
  );
}
