// The page friends open on their phones during a party session (/guest): search or
// paste a song to add it, and vote on the queue. No audio here — the DJ's computer plays.

import { useEffect, useState } from "react";
import { API } from "./api";
import "./Guest.css";

const NAME_KEY = "mydj-guest-name";
const VOTER_KEY = "mydj-voter";
const POLL_MS = 1500;

function load(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — fine for this visit */
  }
}
// One id per phone, so each friend gets one vote per song. (crypto.randomUUID needs
// https, which a home-network http:// page doesn't have.)
function voterId() {
  let v = load(VOTER_KEY);
  if (!v) {
    v = Math.random().toString(36).slice(2) + Date.now().toString(36);
    save(VOTER_KEY, v);
  }
  return v;
}

// The request never reached the music server (vs. the server answering with an error).
class Unreachable extends Error {}

async function api(path, { timeout = 8000, ...opts } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...opts, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new Unreachable("Can't reach the DJ's computer");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Something went wrong (${res.status})`);
  return data;
}
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function fmtDur(s) {
  if (!Number.isFinite(s)) return "";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export default function Guest() {
  const [name, setName] = useState(() => load(NAME_KEY));
  const [voter] = useState(voterId);
  if (!name) return <Join onJoin={(n) => (save(NAME_KEY, n), setName(n))} />;
  return <Party name={name} voter={voter} onRename={() => setName("")} />;
}

function Join({ onJoin }) {
  const [draft, setDraft] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (draft.trim()) onJoin(draft.trim().slice(0, 30));
  };
  return (
    <div className="guest">
      <h1>🎧 MyDJ party</h1>
      <form className="g-join" onSubmit={submit}>
        <label htmlFor="g-name">What's your name?</label>
        <input
          id="g-name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="So friends know who added what"
          autoFocus
        />
        <button className="g-btn primary" disabled={!draft.trim()}>
          Join
        </button>
      </form>
    </div>
  );
}

function Party({ name, voter, onRename }) {
  const [queue, setQueue] = useState(null);
  // connecting -> ok, or unreachable (never got through) / lost (got through before)
  const [conn, setConn] = useState("connecting");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const q = await api(
        `/api/party/queue?voter=${encodeURIComponent(voter)}&name=${encodeURIComponent(name)}`,
        { timeout: 5000 }
      );
      setQueue(q);
      setConn("ok");
    } catch (e) {
      if (e instanceof Unreachable) setConn((c) => (c === "ok" || c === "lost" ? "lost" : "unreachable"));
      else setNotice(e.message);
    }
  }
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll for the page's lifetime
  }, []);

  async function vote(track, value) {
    const next = track.myVote === value ? 0 : value; // tap again to take it back
    setQueue((q) => ({
      ...q,
      upcoming: q.upcoming.map((t) =>
        t.id === track.id ? { ...t, myVote: next, score: t.score - t.myVote + next } : t
      ),
    }));
    try {
      await post("/api/party/vote", { trackId: track.id, voter, value: next });
      setNotice("");
    } catch (e) {
      setNotice(`Your vote didn't go through: ${e.message}`);
    }
    refresh();
  }

  return (
    <div className="guest">
      <header className="g-head">
        <h1>🎧 MyDJ party</h1>
        <button className="g-link" onClick={onRename} title="Change your name">
          👤 {name}
        </button>
      </header>
      <ConnectionBar conn={conn} queue={queue} />
      <AddSong name={name} voter={voter} onSent={refresh} />
      {notice && <div className="g-error">{notice}</div>}
      {queue && <Queue queue={queue} onVote={vote} />}
    </div>
  );
}

// Always-visible answer to "is this working?".
function ConnectionBar({ conn, queue }) {
  let tone = "wait";
  let title = "Connecting to the DJ's computer…";
  let detail = "";
  if (conn === "unreachable") {
    tone = "bad";
    title = "Can't reach the DJ's music server";
    detail =
      "This page came from the DJ's computer, so your Wi-Fi is right. On the DJ's computer: " +
      "allow Python through Windows Firewall (Private networks), or restart MyDJ with start.ps1. " +
      "Retrying…";
  } else if (conn === "lost") {
    tone = "bad";
    title = "Lost connection to the DJ — retrying…";
    detail = "Make sure you're still on the same Wi-Fi as the DJ (not mobile data).";
  } else if (conn === "ok" && queue && !queue.hostOnline) {
    tone = "warn";
    title = "Connected, but the DJ's party session is off";
    detail = "You can still add songs — they'll join the queue when it's back on.";
  } else if (conn === "ok" && queue) {
    tone = "ok";
    const n = queue.guests?.length || 1;
    title = "Connected to the DJ";
    detail = n > 1 ? `${n} phones here` : "You're the first one here";
  }
  return (
    <div className={`g-conn ${tone}`} role="status">
      <span className="dot" />
      <div>
        <div className="g-conn-title">{title}</div>
        {detail && <div className="g-conn-detail">{detail}</div>}
      </div>
    </div>
  );
}

function AddSong({ name, voter, onSent }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [sent, setSent] = useState({}); // url -> "sending" | "sent" | error message
  const [error, setError] = useState("");

  async function request(url, title) {
    setSent((s) => ({ ...s, [url]: "sending" }));
    try {
      await post("/api/party/request", { url, name, voter, title: title || "" });
      setSent((s) => ({ ...s, [url]: "sent" }));
      onSent();
    } catch (e) {
      setSent((s) => ({ ...s, [url]: e.message }));
    }
  }

  async function submit(e) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    setError("");
    if (/^https?:\/\//i.test(q)) {
      setResults([{ url: q, title: q }]);
      setText("");
      request(q);
      return;
    }
    setSearching(true);
    try {
      const { results: found } = await api(`/api/search?q=${encodeURIComponent(q)}`, {
        timeout: 20000,
      });
      setResults(found);
      if (!found.length) setError("No results — try other words, or paste a link.");
    } catch (e2) {
      setError(e2.message);
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="g-add">
      <form onSubmit={submit} className="g-search">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search a song or paste a link"
          enterKeyHint="search"
        />
        <button className="g-btn primary" disabled={!text.trim() || searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <div className="g-error">{error}</div>}
      {results.length > 0 && (
        <ul className="g-results">
          {results.map((r) => {
            const st = sent[r.url];
            const failed = st && st !== "sending" && st !== "sent";
            return (
              <li key={r.url}>
                {r.thumbnail && <img src={r.thumbnail} alt="" />}
                <div className="g-main">
                  <div className="g-title">{r.title}</div>
                  <div className="g-sub">
                    {[r.channel, fmtDur(r.duration)].filter(Boolean).join(" · ")}
                  </div>
                  {failed && <div className="g-error">{st}</div>}
                </div>
                <button
                  className="g-btn"
                  onClick={() => request(r.url, r.title === r.url ? "" : r.title)}
                  disabled={st === "sending" || st === "sent"}
                >
                  {st === "sending" ? "Sending…" : st === "sent" ? "Requested ✓" : "＋ Add"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Queue({ queue, onVote }) {
  const { now, next, upcoming, pending } = queue;
  return (
    <section className="g-queue">
      {now && <Song label="NOW PLAYING" t={now} />}
      {next && <Song label="UP NEXT" t={next} />}
      {pending.length > 0 && <h2>On the way</h2>}
      {pending.map((p) => (
        <div key={p.rid} className={`g-song pending ${p.status}`}>
          <div className="g-main">
            <div className="g-title">{p.title || "A pasted link"}</div>
            <div className="g-sub">
              👤 {p.addedBy} ·{" "}
              {p.status === "downloading"
                ? "⏳ downloading & analyzing (usually 10–30 s)"
                : p.status === "ready"
                  ? "✓ ready — joining the queue…"
                  : `⚠ couldn't add: ${p.error}`}
            </div>
          </div>
        </div>
      ))}
      <h2>Queue {upcoming.length > 0 && `· ${upcoming.length}`}</h2>
      {upcoming.length === 0 && (
        <div className="g-note">Nothing queued yet — add a song!</div>
      )}
      {upcoming.map((t) => (
        <Song key={t.id} t={t} onVote={onVote} />
      ))}
    </section>
  );
}
function Song({ t, label, onVote }) {
  return (
    <div className={`g-song ${label ? "featured" : ""}`}>
      <div className="g-main">
        {label && <div className="g-label">{label}</div>}
        <div className="g-title">{t.title}</div>
        <div className="g-sub">
          {[t.addedBy ? `👤 ${t.addedBy}` : "🎧 DJ", t.genre].filter(Boolean).join(" · ")}
        </div>
      </div>
      {onVote && (
        <div className="g-vote">
          <button
            className={t.myVote > 0 ? "on" : ""}
            onClick={() => onVote(t, 1)}
            aria-label={`Upvote ${t.title}`}
          >
            ▲
          </button>
          <span className="g-score">{t.score}</span>
          <button
            className={t.myVote < 0 ? "on down" : ""}
            onClick={() => onVote(t, -1)}
            aria-label={`Downvote ${t.title}`}
          >
            ▼
          </button>
        </div>
      )}
    </div>
  );
}
