import { useEffect, useRef, useState } from "react";
import { Engine } from "./audioEngine";
import { relativeEnergies } from "./ordering";
import Waveform from "./Waveform";
import "./App.css";

const API = "http://localhost:8000";

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new Engine();
  const engine = engineRef.current;
  if (typeof window !== "undefined" && import.meta.env.DEV) window.engine = engine; // dev-only debug hook

  const [, force] = useState(0);
  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    let raf = null;
    let last = 0;
    const playing = () => engine.deckA?.isPlaying || engine.deckB?.isPlaying;
    const loop = (now) => {
      // Repaint the playhead at ~20fps — a full-tree re-render at 60fps for hours
      // needlessly competes with the audio thread. onChange still paints on real events.
      if (now - last >= 50) {
        last = now;
        rerender();
      }
      raf = playing() ? requestAnimationFrame(loop) : null;
    };
    engine.onChange = () => {
      rerender();
      if (playing() && raf == null) raf = requestAnimationFrame(loop);
    };
    return () => {
      if (raf) cancelAnimationFrame(raf);
      engine.onChange = null;
    };
  }, [engine]);

  // Keep audio alive over a long set: browsers can suspend the AudioContext when the
  // tab is backgrounded or the machine sleeps. Re-resume on focus / statechange / tick.
  useEffect(() => {
    const wake = () => {
      const ctx = engine.ctx;
      const shouldPlay = engine.auto?.active || engine.deckA?.isPlaying || engine.deckB?.isPlaying;
      if (ctx && ctx.state === "suspended" && shouldPlay) engine.resume();
    };
    const onVis = () => {
      if (!document.hidden) wake();
    };
    document.addEventListener("visibilitychange", onVis);
    if (engine.ctx) engine.ctx.onstatechange = wake;
    const iv = setInterval(wake, 4000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(iv);
      if (engine.ctx) engine.ctx.onstatechange = null;
    };
  }, [engine]);

  return (
    <div className="app">
      <header>
        <h1>🎧 MyDJ</h1>
        <p className="sub">
          AI-sequenced party set · beat-matched harmonic transitions · nothing saved to disk
        </p>
      </header>

      <div className="decks">
        <DeckMini engine={engine} which="A" />
        <DeckMini engine={engine} which="B" />
      </div>
      <Crossfader engine={engine} />
      <Playlist engine={engine} />
    </div>
  );
}

function DeckMini({ engine, which }) {
  const d = engine.deck(which);
  const has = !!d.buffer;
  const running = engine.auto.active; // manual controls are locked during an auto-set
  const dur = has ? d.buffer.duration : 0;
  const pos = d.position();
  const pct = dur ? (pos / dur) * 100 : 0;
  return (
    <div className={`deck deck-${which} ${d.isPlaying ? "live" : ""}`}>
      <div className="deck-head">
        <span className="badge">{which}</span>
        <div className="track">
          <div className="title" title={has ? d.meta.title : ""}>
            {has ? d.meta.title : "—"}
          </div>
          <div className="chips">
            {has && d.baseBpm && <span className="chip bpm">{Math.round(d.effectiveBpm)} BPM</span>}
            {has && d.meta?.camelot && <span className="chip key">{d.meta.camelot}</span>}
            {has && d.meta?.energy != null && <span className="chip nrg">⚡{d.meta.energy}</span>}
            {has && d.meta?.genre && <span className="chip genre">{d.meta.genre}</span>}
          </div>
        </div>
      </div>
      <Waveform
        buffer={d.buffer}
        position={pos}
        duration={dur}
        cue={d.cue}
        intro={d.meta?.introEnd}
        outro={d.meta?.outroStart}
        accent={which === "A" ? "#22d3ee" : "#fb7185"}
        onSeek={(t) => !running && engine.seek(which, t)}
      />
      <div className="times">
        <span>{fmt(pos)}</span>
        <span>{fmt(dur)}</span>
      </div>
      <div className="deck-controls">
        <button
          className="ghost sm"
          onClick={() => engine.togglePlay(which)}
          disabled={!has || running}
        >
          {d.isPlaying ? "❚❚" : "►"}
        </button>
        <button
          className="ghost sm"
          onClick={() => engine.setCue(which)}
          disabled={!has || running}
        >
          ⚑ Set cue
        </button>
        <button
          className="ghost sm"
          onClick={() => engine.jumpCue(which)}
          disabled={!has || running}
        >
          ↩ Cue
        </button>
      </div>
    </div>
  );
}

function Crossfader({ engine }) {
  const running = engine.auto.active; // the auto-mixer owns the crossfader during a set
  return (
    <div className="crossfader">
      <div className="xf-row">
        <span className="xf-a">A</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={engine.crossfade}
          onChange={(e) => engine.setCrossfade(parseFloat(e.target.value))}
          disabled={running}
        />
        <span className="xf-b">B</span>
      </div>
      <div className="xf-extra">
        <button
          className={`toggle ${engine.keyLock ? "on" : ""}`}
          onClick={() => engine.setKeyLock(!engine.keyLock)}
          disabled={running}
          title={
            running
              ? "The auto-mixer manages tempo during a set"
              : "Pitch-preserving tempo (no chipmunk on beatmatch). Applies when decks next start."
          }
        >
          🔒 Key-lock: {engine.keyLock ? "ON" : "OFF"}
        </button>
      </div>
    </div>
  );
}

function Playlist({ engine }) {
  const auto = engine.auto;
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const tracks = engine.playlist;
  const trans = engine.transitions;
  const running = auto.active;

  async function add() {
    const u = url.trim();
    if (!u) return;
    setError("");
    setAdding(true);
    try {
      await engine.addTrack(u);
      setUrl("");
    } catch (e) {
      setError(e.message || "Couldn't add track");
    } finally {
      setAdding(false);
    }
  }

  function orderAlgo() {
    setError("");
    engine.orderPlaylist();
  }

  async function aiPolish() {
    setError("");
    setBusy("ai");
    try {
      const rel = relativeEnergies(tracks);
      const payload = tracks.map((t, i) => ({
        id: t.id,
        title: t.title,
        bpm: t.bpm ? Math.round(t.bpm) : null,
        camelot: t.camelot,
        energy: rel[i], // relative-ranked energy (robust to noisy absolutes)
      }));
      const res = await fetch(`${API}/api/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: payload }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || `AI order failed (${res.status})`);
      }
      const data = await res.json();
      engine.applyAiOrder(data.order);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function startSet() {
    setError("");
    if (tracks.length < 2) {
      setError("Add at least two tracks.");
      return;
    }
    try {
      await auto.start();
    } catch (e) {
      setError(e.message || "Couldn't start the set");
      auto.stop();
    }
  }

  return (
    <div className="playlist">
      <div className="pl-head">
        <div className="xf-label">PLAYLIST · {tracks.length}</div>
        <div className="status">
          {running
            ? `${auto.status === "transitioning" ? "mixing…" : auto.status} · ${Math.min(
                auto.idx + 1,
                tracks.length
              )}/${tracks.length}`
            : auto.status === "done"
            ? "set finished"
            : ""}
        </div>
      </div>

      <div className="loadbar">
        <input
          type="url"
          placeholder="paste a track URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !adding && add()}
          disabled={adding || running}
        />
        <button className="ghost" onClick={add} disabled={adding || running || !url.trim()}>
          {adding ? <span className="spinner" /> : "+ Add"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      <ol className="tracks">
        {tracks.length === 0 && (
          <div className="muted empty">Add tracks, then order them into a party set.</div>
        )}
        {tracks.map((t, i) => (
          <li key={t.id} className={running && auto.idx === i ? "current" : ""}>
            <div className="t-row">
              <span className="num">{i + 1}</span>
              <div className="t-main">
                <div className="t-title" title={t.title}>
                  {t.title}
                </div>
                <div className="chips">
                  <span className="chip bpm">{t.bpm ? Math.round(t.bpm) + " BPM" : "– BPM"}</span>
                  <span className="chip key">
                    {t.camelot || "?"}
                    {t.key ? " · " + t.key : ""}
                  </span>
                  <span className="chip nrg">⚡{t.energy ?? "–"}</span>
                  {t.genre && <span className="chip genre">{t.genre}</span>}
                </div>
              </div>
              {!running && (
                <button className="x" onClick={() => engine.removeTrack(t.id)} title="remove">
                  ✕
                </button>
              )}
            </div>
            {i < tracks.length - 1 && trans[i] && <TransitionBadge q={trans[i]} />}
          </li>
        ))}
      </ol>

      <div className="pl-controls">
        <label className="slider">
          <span>Blend</span>
          <input
            type="range"
            min="4"
            max="32"
            step="1"
            value={auto.transitionSecs}
            onChange={(e) => {
              auto.transitionSecs = parseInt(e.target.value, 10);
              engine.emit();
            }}
            disabled={running}
          />
          <span className="val">{auto.transitionSecs}s</span>
        </label>
        <button className="ghost" onClick={orderAlgo} disabled={running || tracks.length < 3}>
          🎚 Order for Party
        </button>
        <button
          className="ghost"
          onClick={aiPolish}
          disabled={running || tracks.length < 3 || busy === "ai"}
        >
          {busy === "ai" ? <span className="spinner" /> : "✨ AI Polish"}
        </button>
        <button
          className={`toggle ${auto.loop ? "on" : ""}`}
          onClick={() => {
            auto.loop = !auto.loop;
            engine.emit();
          }}
          title="Loop the set back to the start at the end — never stops"
        >
          🔁 Loop: {auto.loop ? "ON" : "OFF"}
        </button>
        {running ? (
          <button className="stop" onClick={() => auto.stop()}>
            ⏹ Stop
          </button>
        ) : (
          <button className="go" onClick={startSet} disabled={tracks.length < 2}>
            ▶ Start Set
          </button>
        )}
      </div>
    </div>
  );
}

function TransitionBadge({ q }) {
  return (
    <div className={`xbadge ${q.label}`}>
      <span className="dotq" />
      <span>{q.label}</span>
      <span className="xmeta">
        {q.bpmDeltaPct}% BPM · key {Math.round(q.keyCompat * 100)}% · energy{" "}
        {q.energyStep >= 0 ? "+" : ""}
        {q.energyStep}
      </span>
    </div>
  );
}
