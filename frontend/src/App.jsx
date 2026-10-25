import { useEffect, useRef, useState } from "react";
import { Engine, API } from "./audioEngine";
import { API_LABEL } from "./api";
import { relativeEnergies } from "./ordering";
import { PartyHost } from "./party";
import QRCode from "qrcode";
import Waveform from "./Waveform";
import Art from "./Art";
import "./App.css";

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
const isUrl = (s) => /^https?:\/\//i.test(s.trim());

export default function App() {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new Engine();
  const engine = engineRef.current;
  if (typeof window !== "undefined" && import.meta.env.DEV) window.engine = engine; // dev-only debug hook
  const partyRef = useRef(null);
  if (!partyRef.current) partyRef.current = new PartyHost(engine);
  const party = partyRef.current;
  useEffect(() => () => party.stop(), [party]);
  const [error, setError] = useState("");

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

  async function startSet(startIdx = 0) {
    setError("");
    if (engine.playlist.length < 2) {
      setError("Add at least two songs to start a set.");
      return;
    }
    try {
      await engine.auto.start(typeof startIdx === "number" ? startIdx : 0);
    } catch (e) {
      setError(e.message || "Couldn't start the set");
      engine.auto.stop();
    }
  }

  return (
    <div className="app">
      <TopBar engine={engine} party={party} onStart={() => startSet(0)} />
      {engine.resumable && !engine.auto.active && (
        <div className="banner">
          <span>⟳ A previous set was interrupted.</span>
          <button
            className="btn"
            onClick={() => {
              const i = engine.resumable?.idx || 0;
              engine.resumable = null;
              startSet(i);
            }}
          >
            Resume from song {(engine.resumable.idx || 0) + 1}
          </button>
          <button
            className="icon-btn"
            aria-label="Dismiss"
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
      {error && <div className="error">{error}</div>}
      <div className="layout">
        <div className="main-col">
          <NowPlaying engine={engine} onStart={() => startSet(0)} />
          <Queue engine={engine} party={party} setError={setError} />
        </div>
        <aside className="side-col">
          <PartyCard party={party} />
          <SetOptions engine={engine} />
        </aside>
      </div>
      <details className="card manual">
        <summary>
          <span>🎛 Manual decks</span>
          <span className="hint">Two decks, crossfader and cue points for mixing by hand</span>
        </summary>
        <div className="decks">
          <DeckMini engine={engine} which="A" />
          <DeckMini engine={engine} which="B" />
        </div>
        <Crossfader engine={engine} />
      </details>
    </div>
  );
}

// ---- Top bar: what state the set is in, and the one button that matters --------------
function TopBar({ engine, party, onStart }) {
  const auto = engine.auto;
  const n = engine.playlist.length;
  let status = n ? `${n} song${n > 1 ? "s" : ""} ready` : "No songs yet";
  let tone = "idle";
  if (auto.active) {
    tone = auto.status === "transitioning" ? "mixing" : "live";
    status = `${auto.status === "transitioning" ? "Mixing" : "Live"} · song ${Math.min(auto.idx + 1, n)} of ${n}`;
  } else if (auto.status === "done") status = "Set finished";
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">🎧</span> MyDJ
      </div>
      <div className={`set-status ${tone}`}>
        <span className="dot" /> {status}
      </div>
      <div className="topbar-actions">
        {party.on && (
          <span className="pill" title="Party session on">
            📱 {party.guests.length} {party.guests.length === 1 ? "phone" : "phones"}
          </span>
        )}
        {auto.active ? (
          <button className="btn stop" onClick={() => auto.stop()}>
            ■ Stop
          </button>
        ) : (
          <button className="btn primary" onClick={onStart} disabled={n < 2}>
            ▶ Start set
          </button>
        )}
      </div>
    </header>
  );
}

function songMeta(t) {
  return [
    t.bpm ? `${Math.round(t.bpm)} BPM` : null,
    t.camelot ? `${t.camelot}${t.key ? ` · ${t.key}` : ""}` : null,
    t.energy != null ? `⚡${t.energy}` : null,
    t.genre,
    stemsLabel(t),
  ]
    .filter(Boolean)
    .join(" · ");
}

// Vocal separation progress (it runs in the background, ~a minute per song).
function stemsLabel(t) {
  if (t.stems === "queued") return "🎤 waiting to split vocals";
  if (t.stems === "running") return `🎤 splitting vocals ${Math.round((t.stemProgress || 0) * 100)}%`;
  if (t.stems === "done") return t.vocals?.length ? "🎤 vocals split" : "🎤 instrumental";
  if (t.stems === "failed") return "🎤 couldn't split vocals";
  return null;
}

// ---- Now Playing ----------------------------------------------------------------------
function NowPlaying({ engine, onStart }) {
  const auto = engine.auto;
  const info = auto.nowInfo();
  const n = engine.playlist.length;

  if (!info) {
    const first = engine.playlist[0];
    return (
      <section className="card now idle" aria-label="Now playing">
        <div className="now-label">NOW PLAYING</div>
        {first ? (
          <>
            <div className="now-empty-title">Ready to go</div>
            <p className="hint">
              {n} song{n > 1 ? "s" : ""} queued, starting with <b>{first.title}</b>. Hit Start set and
              MyDJ mixes the rest hands-free.
            </p>
            <button className="btn primary big" onClick={onStart} disabled={n < 2}>
              ▶ Start set
            </button>
          </>
        ) : (
          <>
            <div className="now-empty-title">Nothing playing yet</div>
            <p className="hint">
              Add a few songs below (search by name or paste a link), then hit Start set.
            </p>
          </>
        )}
      </section>
    );
  }

  const { track, next, pos, dur, mixAt, style, transitioning, canMixNow } = info;
  const front = engine.deck(auto.front);
  const until = mixAt != null ? mixAt - pos : null;
  return (
    <section className="card now" aria-label="Now playing">
      {track?.thumbnail && <img className="now-glow" src={track.thumbnail} alt="" />}
      <div className="now-body">
        <Art track={track} size={132} />
        <div className="now-text">
          <div className="now-label">{transitioning ? "MIXING" : "NOW PLAYING"}</div>
          <div className="now-title" title={track?.title}>
            {track?.title}
          </div>
          <div className="now-artist">
            {[track?.uploader, track?.addedBy && `👤 ${track.addedBy}`].filter(Boolean).join(" · ")}
          </div>
          <div className="now-meta">{track && songMeta(track)}</div>
        </div>
      </div>
      <Waveform
        buffer={front.buffer}
        position={pos}
        duration={dur}
        outro={mixAt}
        accent="#8f73ff"
      />
      <div className="now-times">
        <span>{fmt(pos)}</span>
        <span className="now-next">
          {transitioning
            ? `${style || "Mixing"} → ${next?.title || "the next song"}`
            : next
              ? until != null && until > 0
                ? `Mixing into ${next.title} in ${fmt(until)}`
                : `Mixing into ${next.title} soon`
              : "Last song of the set"}
        </span>
        <span>{fmt(dur)}</span>
      </div>
      <div className="now-actions">
        {style && !transitioning && <span className="now-style">{style}</span>}
        <button
          className="btn"
          onClick={() => auto.mixNow()}
          disabled={!canMixNow}
          title="Floor getting bored? Start the blend into the next song now"
        >
          ⏭ Mix now
        </button>
      </div>
    </section>
  );
}

// ---- Queue: add songs, see what's coming, steer it ------------------------------------
function Queue({ engine, party, setError }) {
  const auto = engine.auto;
  const tracks = engine.playlist;
  const trans = engine.transitions;
  const running = auto.active;
  const [busy, setBusy] = useState("");

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

  return (
    <section className="card queue" aria-label="Queue">
      <div className="card-head">
        <h2>
          Queue <span className="count">{tracks.length}</span>
        </h2>
        <div className="card-actions">
          <button
            className="btn sm"
            onClick={() => (setError(""), engine.orderPlaylist())}
            disabled={running || tracks.length < 3}
            title="Re-sequence the whole list: harmonic, small tempo steps, warm-up → peak → wind-down"
          >
            🎚 Order for Party
          </button>
          <button
            className="btn sm"
            onClick={aiPolish}
            disabled={running || tracks.length < 3 || busy === "ai"}
            title="Let Claude sequence the set (needs ANTHROPIC_API_KEY)"
          >
            {busy === "ai" ? <span className="spinner" /> : "✨ AI Polish"}
          </button>
        </div>
      </div>
      <AddSong engine={engine} />
      <ol className="tracks">
        {tracks.length === 0 && (
          <div className="empty hint">Your queue is empty. Search for a song or paste a link above.</div>
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
                <span className="num">{isCurrent ? "▶" : i + 1}</span>
                <Art track={t} size={44} />
                <div className="t-main">
                  <div className="t-title" title={t.title}>
                    {t.title}
                  </div>
                  <div className="t-sub">
                    {t.uploader && <span>{t.uploader}</span>}
                    {t.addedBy && <span className="who">👤 {t.addedBy}</span>}
                  </div>
                  <div className="t-meta">{songMeta(t)}</div>
                </div>
                {party.on && !!t.score && (
                  <span className={`votes ${t.score < 0 ? "down" : ""}`} title="Votes from phones">
                    {t.score > 0 ? "▲" : "▼"} {Math.abs(t.score)}
                  </span>
                )}
                {isCurrent && <span className="tag now">NOW</span>}
                {isNext && <span className="tag">NEXT</span>}
                <div className="t-actions">
                  {running && !isCurrent && !isNext && !locked && (
                    <button className="btn sm" onClick={() => engine.playNext(t.id)} title="Play this next">
                      ⏭ Next
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    onClick={() => engine.moveTrack(t.id, i - 1)}
                    disabled={locked || i === 0}
                    aria-label="Move up"
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => engine.moveTrack(t.id, i + 1)}
                    disabled={locked || i === tracks.length - 1}
                    aria-label="Move down"
                    title="Move down"
                  >
                    ▼
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => engine.removeTrack(t.id)}
                    disabled={locked}
                    aria-label="Remove"
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
    </section>
  );
}

// Search YouTube by name (like the phones do) or paste a link.
function AddSong({ engine }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [state, setState] = useState({}); // url -> "adding" | "added" | error message
  const [error, setError] = useState("");

  async function add(url, { pasted = false } = {}) {
    setState((s) => ({ ...s, [url]: "adding" }));
    try {
      await engine.addTrack(url);
      setState((s) => ({ ...s, [url]: "added" }));
      // A pasted link has nothing else to pick from: clear it once it's in the queue.
      if (pasted) setTimeout(() => setResults((r) => r.filter((x) => x.url !== url)), 1500);
    } catch (e) {
      setState((s) => ({ ...s, [url]: e.message || "Couldn't add this song" }));
    }
  }

  async function submit(e) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    setError("");
    if (isUrl(q)) {
      setText("");
      setResults([{ url: q, title: q, pasted: true }]);
      add(q, { pasted: true });
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Search failed (${res.status})`);
      setResults(data.results || []);
      if (!data.results?.length) setError("No results — try other words, or paste a link.");
    } catch (e2) {
      setError(
        e2 instanceof TypeError ? `Can't reach the music server at ${API_LABEL} — is it running?` : e2.message
      );
    } finally {
      setSearching(false);
    }
  }

  const adding = Object.values(state).filter((s) => s === "adding").length;
  return (
    <div className="add">
      <form className="loadbar" onSubmit={submit}>
        <input
          type="text"
          placeholder="Search a song or paste a link…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Search a song or paste a link"
        />
        <button className="btn primary" disabled={!text.trim() || searching}>
          {searching ? <span className="spinner" /> : isUrl(text) ? "+ Add" : "Search"}
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      {results.length > 0 && (
        <div className="results">
          <div className="results-head">
            <span className="hint">
              {adding > 0
                ? `Adding ${adding} song${adding > 1 ? "s" : ""} — downloading & analyzing…`
                : results.every((r) => r.pasted)
                  ? "Pasted link"
                  : "Results"}
            </span>
            <button className="icon-btn" aria-label="Close results" onClick={() => setResults([])}>
              ✕
            </button>
          </div>
          <ul>
            {results.map((r) => {
              const st = state[r.url];
              const failed = st && st !== "adding" && st !== "added";
              return (
                <li key={r.url}>
                  <Art track={r} size={40} />
                  <div className="t-main">
                    <div className="t-title">{r.title}</div>
                    <div className="t-sub">
                      {[r.channel, r.duration ? fmt(r.duration) : null].filter(Boolean).join(" · ")}
                    </div>
                    {failed && <div className="err-text">{st}</div>}
                  </div>
                  <button
                    className="btn sm"
                    onClick={() => add(r.url)}
                    disabled={st === "adding" || st === "added"}
                  >
                    {st === "adding" ? <span className="spinner" /> : st === "added" ? "Added ✓" : "+ Add"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
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

// ---- Party session: friends on the same Wi-Fi scan the code to add songs and vote ----
function PartyCard({ party }) {
  const urls = party.on ? party.joinUrls() : [];
  const url = urls[party.selected];
  const [qr, setQr] = useState({ url: "", src: "" });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 240 }).then((src) => alive && setQr({ url, src }));
    return () => {
      alive = false;
    };
  }, [url]);
  const c = party.check;

  if (!party.on)
    return (
      <section className="card party" aria-label="Party session">
        <h2>📱 Party session</h2>
        <p className="hint">
          Friends on your Wi-Fi scan a code, then add songs and vote from their phones.
        </p>
        <button className="btn primary" onClick={() => party.start()}>
          Start party session
        </button>
      </section>
    );

  return (
    <section className="card party on" aria-label="Party session">
      <div className="card-head">
        <h2>
          <span className="live-dot" /> Party session
        </h2>
        <button className="btn sm" onClick={() => party.stop()}>
          End
        </button>
      </div>
      {!party.loaded && !party.error && <div className="hint">Looking up this computer's address…</div>}
      {party.loaded && party.addresses.length === 0 && (
        <div className="error">
          This computer doesn't seem to be on a network. Connect it to your Wi-Fi, then end and start
          the party session again.
        </div>
      )}
      {url && (
        <>
          <div className="qr">
            {qr.url === url && <img src={qr.src} alt="QR code to join the party" />}
          </div>
          <div className="join">
            <div className="hint">Scan with a phone camera, or open</div>
            <div className="party-url">{url}</div>
          </div>
          {urls.length > 1 && (
            <div className="party-alt">
              <span className="hint">Doesn't open? Try:</span>
              {urls.map((u, i) =>
                i === party.selected ? null : (
                  <button key={u} className="btn sm" onClick={() => party.select(i)}>
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
                    : "Music server not answering on your network — keep the backend window open (restart with .\\start.ps1)"
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
        </>
      )}
      {party.error && <div className="error">{party.error}</div>}
      <details className="party-help">
        <summary>Phones can't connect?</summary>
        <ol>
          <li>
            The phone must be on the <b>same Wi-Fi</b> as this computer — not mobile data, and not a
            "guest" Wi-Fi (those usually block devices from seeing each other).
          </li>
          <li>
            <b>Windows Firewall:</b> Start → "Allow an app through Windows Firewall" → Change settings
            → tick <b>Private</b> for <b>Node.js JavaScript Runtime</b> and <b>Python</b>. (Or accept
            the prompt Windows shows the first time you run start.ps1.)
          </li>
          <li>
            Your Wi-Fi must be a <b>Private</b> network: Settings → Network &amp; internet → Wi-Fi →
            your network → Network profile type → Private.
          </li>
          <li>Turn off any VPN on this computer or the phone.</li>
          <li>If more than one address is listed above, try the others.</li>
        </ol>
        <div className="hint">Once a phone shows up under "phones connected", everything is working.</div>
      </details>
    </section>
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

// ---- Set options: how the hands-free mixer behaves ------------------------------------
function SetOptions({ engine }) {
  const auto = engine.auto;
  const [copied, setCopied] = useState("");
  const [copyText, setCopyText] = useState(""); // shown for manual copy if the clipboard is blocked
  const tracks = engine.playlist;

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

  const set = (fn) => () => {
    fn();
    engine.saveSession();
    engine.emit();
  };
  return (
    <section className="card options" aria-label="Set options">
      <h2>Set options</h2>
      <label className="blend">
        <span>
          Blend <small className="hint">how long each transition lasts</small>
        </span>
        <span className="blend-row">
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
            disabled={auto.active}
            aria-label="Blend length"
          />
          <span className="val">{auto.transitionSecs}s</span>
        </span>
      </label>
      <Switch
        label="🪄 Auto-order"
        hint="Slot each new song into its best spot"
        on={engine.autoOrder}
        onChange={set(() => (engine.autoOrder = !engine.autoOrder))}
      />
      <Switch
        label="🔥 Party mode"
        hint="Leave each song after its big moment"
        on={auto.party}
        onChange={set(() => (auto.party = !auto.party))}
      />
      <Switch
        label="🔊 Volume match"
        hint="Every song at the same loudness"
        on={engine.volumeMatch}
        onChange={() => engine.setVolumeMatch(!engine.volumeMatch)}
      />
      <Switch
        label="🔁 Loop"
        hint="Start over at the end — never stop"
        on={auto.loop}
        onChange={set(() => (auto.loop = !auto.loop))}
      />
      {tracks.length > 0 && (
        <button
          className="btn sm ghost-link"
          onClick={copySongData}
          title="Copy each song's analysis (tempo, key, loudness, detected big parts) as text"
        >
          {copied || "📋 Copy song data"}
        </button>
      )}
      {copyText && (
        <div className="copybox">
          <div className="copybox-head">
            <span>Clipboard blocked — select all and copy:</span>
            <button className="icon-btn" onClick={() => setCopyText("")} aria-label="Close">
              ✕
            </button>
          </div>
          <textarea readOnly value={copyText} onFocus={(e) => e.target.select()} autoFocus />
        </div>
      )}
    </section>
  );
}

function Switch({ label, hint, on, onChange }) {
  return (
    <button className="switch-row" role="switch" aria-checked={on} onClick={onChange}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        <span className="hint">{hint}</span>
      </span>
      <span className={`switch ${on ? "on" : ""}`} aria-hidden="true">
        <span className="knob" />
      </span>
    </button>
  );
}

// ---- Manual decks (hands-on mixing) ---------------------------------------------------
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
          <div className="t-meta">{has && d.meta ? songMeta({ ...d.meta, bpm: d.effectiveBpm }) : ""}</div>
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
        <button className="btn sm" onClick={() => engine.togglePlay(which)} disabled={!has || running}>
          {d.isPlaying ? "❚❚" : "►"}
        </button>
        <button className="btn sm" onClick={() => engine.setCue(which)} disabled={!has || running}>
          ⚑ Set cue
        </button>
        <button className="btn sm" onClick={() => engine.jumpCue(which)} disabled={!has || running}>
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
          aria-label="Crossfader"
        />
        <span className="xf-b">B</span>
      </div>
      <div className="xf-extra">
        <button
          className={`btn sm ${engine.keyLock ? "on" : ""}`}
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
