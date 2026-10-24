import { useEffect, useRef, useState } from "react";
import { Engine, API } from "./audioEngine";
import { relativeEnergies } from "./ordering";
import { PartyHost } from "./party";
import QRCode from "qrcode";
import Waveform from "./Waveform";
import "./App.css";

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
  const partyRef = useRef(null);
  if (!partyRef.current) partyRef.current = new PartyHost(engine);
  const party = partyRef.current;
  useEffect(() => () => party.stop(), [party]);
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
      if (!document.hidden) {
        wake();
        if (engine.auto?.active) engine.requestWakeLock(); // wake locks are dropped while hidden
      }
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
      <PartyPanel party={party} />
      <Playlist engine={engine} party={party} />
    </div>
  );
}

function DeckMini({ engine, which }) {
  const d = engine.deck(which);
  const has = !!d.buffer;
  const running = engine.auto.active; // manual controls are locked during an auto-set
  const dur = has ? d.buffer.duration : 0;
  const pos = d.position();
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

// Party session: friends on the same Wi-Fi scan the code to add songs and vote.
function PartyPanel({ party }) {
  const urls = party.on ? party.joinUrls() : [];
  const url = urls[party.selected];
  const [qr, setQr] = useState({ url: "", src: "" });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 200 }).then((src) => alive && setQr({ url, src }));
    return () => {
      alive = false;
    };
  }, [url]);
  const c = party.check;
  return (
    <div className="party">
      <div className="party-head">
        <button
          className={`toggle ${party.on ? "on" : ""}`}
          onClick={() => (party.on ? party.stop() : party.start())}
          title="Let friends on your Wi-Fi add songs and vote from their phones"
        >
          📱 Party session: {party.on ? "ON" : "OFF"}
        </button>
        {party.on && <span className="muted">Friends on your Wi-Fi can add songs and vote.</span>}
      </div>
      {party.on && url && (
        <div className="party-join">
          {qr.url === url && <img src={qr.src} alt="QR code to join the party" />}
          <div className="party-info">
            <div>Scan with a phone camera, or open:</div>
            <div className="party-url">{url}</div>
            {urls.length > 1 && (
              <div className="party-alt">
                <span className="muted">Phones can't open it? Try another address:</span>
                {urls.map((u, i) =>
                  i === party.selected ? null : (
                    <button key={u} className="ghost sm" onClick={() => party.select(i)}>
                      {party.addresses[i]}
                    </button>
                  )
                )}
              </div>
            )}
            <ul className="party-status">
              <Status
                state={c ? (c.backend ? "ok" : "bad") : "wait"}
                text={
                  !c
                    ? "Checking the music server is reachable on your network…"
                    : c.backend
                      ? "Music server reachable on your network"
                      : "Music server only answers on this computer — close MyDJ and start it with .\\start.ps1"
                }
              />
              <Status
                state={c ? (c.app ? "ok" : "bad") : "wait"}
                text={
                  !c
                    ? "Checking the app is reachable on your network…"
                    : c.app
                      ? "App reachable on your network"
                      : "App only answers on this computer — restart it with .\\start.ps1"
                }
              />
              <Status
                state={party.guests.length ? "ok" : "wait"}
                text={
                  party.guests.length
                    ? `${party.guests.length} phone${party.guests.length > 1 ? "s" : ""} connected: ${party.guests.join(", ")}`
                    : "No phones connected yet — scan the code with one to test"
                }
              />
              {(party.working > 0 || party.adding > 0) && (
                <Status
                  state="wait"
                  text={`${party.working + party.adding} song${party.working + party.adding > 1 ? "s" : ""} from friends on the way…`}
                />
              )}
            </ul>
          </div>
        </div>
      )}
      {party.on && !party.loaded && !party.error && (
        <div className="muted">Looking up this computer's network address…</div>
      )}
      {party.on && party.loaded && party.addresses.length === 0 && (
        <div className="error">
          This computer doesn't seem to be on a network. Connect it to your Wi-Fi and turn the party
          session off and on again.
        </div>
      )}
      {party.error && <div className="error">{party.error}</div>}
      {party.on && (
        <details className="party-help">
          <summary>Phones can't connect?</summary>
          <ol>
            <li>
              The phone must be on the <b>same Wi-Fi</b> as this computer — not mobile data, and not
              a "guest" Wi-Fi (those usually block devices from seeing each other).
            </li>
            <li>
              <b>Windows Firewall:</b> Start → "Allow an app through Windows Firewall" → Change
              settings → tick <b>Private</b> for <b>Node.js JavaScript Runtime</b> and{" "}
              <b>Python</b>. (Or accept the prompt Windows shows the first time you run
              start.ps1.)
            </li>
            <li>
              Your Wi-Fi must be a <b>Private</b> network: Settings → Network &amp; internet → Wi-Fi →
              your network → Network profile type → Private.
            </li>
            <li>Turn off any VPN on this computer or the phone.</li>
            <li>If you have more than one address listed above, try the others.</li>
          </ol>
          <div className="muted">
            Once a phone shows up under "phones connected", everything is working.
          </div>
        </details>
      )}
    </div>
  );
}

function Status({ state, text }) {
  const icon = { ok: "✅", bad: "❌", wait: "⏳" }[state];
  return (
    <li className={`st-${state}`}>
      <span>{icon}</span> {text}
    </li>
  );
}

function Playlist({ engine, party }) {
  const auto = engine.auto;
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [copyText, setCopyText] = useState(""); // shown for manual copy if the clipboard is blocked
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

  // One song per line: easy to paste into a chat and still readable.
  async function copySongData() {
    const text = "[\n" + engine.songData().map((d) => JSON.stringify(d)).join(",\n") + "\n]";
    try {
      await navigator.clipboard.writeText(text);
      setCopyText("");
      setCopied(`Copied ${tracks.length} song${tracks.length === 1 ? "" : "s"} ✓`);
      setTimeout(() => setCopied(""), 3000);
    } catch {
      setCopyText(text);
    }
  }

  async function startSet(startIdx = 0) {
    setError("");
    if (tracks.length < 2) {
      setError("Add at least two tracks.");
      return;
    }
    try {
      await auto.start(typeof startIdx === "number" ? startIdx : 0);
    } catch (e) {
      setError(e.message || "Couldn't start the set");
      auto.stop();
    }
  }

  return (
    <div className="playlist">
      <div className="pl-head">
        <div className="xf-label">PLAYLIST · {tracks.length}</div>
        {tracks.length > 0 && (
          <button
            className="ghost sm"
            onClick={copySongData}
            title="Copy each song's analysis (tempo, key, loudness, detected big parts) as text"
          >
            {copied || "📋 Copy song data"}
          </button>
        )}
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
          disabled={adding}
        />
        <button className="ghost" onClick={add} disabled={adding || !url.trim()}>
          {adding ? <span className="spinner" /> : "+ Add"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {copyText && (
        <div className="copybox">
          <div className="copybox-head">
            <span>Clipboard blocked — select all and copy:</span>
            <button className="x" onClick={() => setCopyText("")} title="close">
              ✕
            </button>
          </div>
          <textarea readOnly value={copyText} onFocus={(e) => e.target.select()} autoFocus />
        </div>
      )}
      {engine.resumable && !running && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "8px 10px",
            margin: "0 0 8px",
            background: "rgba(34,211,238,0.12)",
            border: "1px solid rgba(34,211,238,0.35)",
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          <span style={{ flex: 1 }}>⟳ A previous set was interrupted.</span>
          <button
            className="ghost sm"
            onClick={() => {
              const i = engine.resumable?.idx || 0;
              engine.resumable = null;
              startSet(i);
            }}
          >
            Resume from track {(engine.resumable.idx || 0) + 1}
          </button>
          <button
            className="x"
            title="dismiss"
            onClick={() => {
              engine.resumable = null;
              engine.clearSession();
              engine.emit();
            }}
          >
            ✕
          </button>
        </div>
      )}

      <ol className="tracks">
        {tracks.length === 0 && (
          <div className="muted empty">Add tracks, then order them into a party set.</div>
        )}
        {tracks.map((t, i) => {
          const isCurrent = running && auto.idx === i;
          const isNext = running && !isCurrent && auto._nextIdx() === i;
          const locked = engine.isLocked(t.id);
          const played = running && !auto.loop && i < auto.idx;
          return (
            <li
              key={t.id}
              className={[isCurrent && "current", isNext && "next", played && "played"]
                .filter(Boolean)
                .join(" ")}
            >
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
                    {t.addedBy && <span className="chip who">👤 {t.addedBy}</span>}
                    {party.on && !!t.score && (
                      <span className={`chip votes ${t.score < 0 ? "down" : ""}`}>
                        {t.score > 0 ? "▲" : "▼"} {Math.abs(t.score)}
                      </span>
                    )}
                  </div>
                </div>
                {isCurrent && <span className="tag now">NOW</span>}
                {isNext && <span className="tag">NEXT</span>}
                <div className="t-actions">
                  {running && !isCurrent && !isNext && !locked && (
                    <button className="ghost sm" onClick={() => engine.playNext(t.id)} title="Play this next">
                      ⏭ Next
                    </button>
                  )}
                  <button
                    className="x"
                    onClick={() => engine.moveTrack(t.id, i - 1)}
                    disabled={locked || i === 0}
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    className="x"
                    onClick={() => engine.moveTrack(t.id, i + 1)}
                    disabled={locked || i === tracks.length - 1}
                    title="Move down"
                  >
                    ▼
                  </button>
                  <button
                    className="x"
                    onClick={() => engine.removeTrack(t.id)}
                    disabled={locked}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              </div>
              {i < tracks.length - 1 && trans[i] && <TransitionBadge q={trans[i]} />}
            </li>
          );
        })}
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
          className={`toggle ${engine.autoOrder ? "on" : ""}`}
          onClick={() => {
            engine.autoOrder = !engine.autoOrder;
            engine.saveSession();
            engine.emit();
          }}
          title="Slot each song you add into its best spot (key, tempo, energy). Off = add to the end."
        >
          🪄 Auto-order: {engine.autoOrder ? "ON" : "OFF"}
        </button>
        <button
          className={`toggle ${engine.volumeMatch ? "on" : ""}`}
          onClick={() => engine.setVolumeMatch(!engine.volumeMatch)}
          title="Play every song at the same loudness, so no song jumps out louder or quieter"
        >
          🔊 Volume match: {engine.volumeMatch ? "ON" : "OFF"}
        </button>
        <button
          className={`toggle ${auto.party ? "on" : ""}`}
          onClick={() => {
            auto.party = !auto.party;
            engine.saveSession();
            engine.emit();
          }}
          title="Mix out right after each song's big part (chorus / drop) instead of playing it to the end"
        >
          🔥 Party mode: {auto.party ? "ON" : "OFF"}
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
          <button className="go" onClick={() => startSet(0)} disabled={tracks.length < 2}>
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
