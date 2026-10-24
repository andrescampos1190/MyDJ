// Web Audio DJ engine: two decks, equal-power crossfader, tempo sync, and the
// primitives the auto-mixer builds on. Lives outside React — React just reads
// state and calls methods. Audio stays in memory; nothing is written to disk.

import { guess } from "web-audio-beat-detector";
import { PitchShifter } from "soundtouchjs";
import { detectKey } from "./keyDetect";
import { matchGainDb, partyMixOut } from "./mixPoints";
import { API } from "./api";
import { bestInsertIndex, bpmDistance, orderForParty, transitionQuality, voteOrder } from "./ordering";

export { API };
const AUDIO_CACHE = "mydj-audio-v1"; // compressed audio kept client-side: playback survives a backend restart
const SESSION_KEY = "mydj-session-v1"; // playlist + position: a tab/browser crash is recoverable
const DROP_AT = -3; // party session: net votes at which a queued song is dropped

// Best-effort client-side cache of a track's compressed audio (Cache API). Makes
// mid-set re-decode backend-independent + instant, and lets a reload resume the set.
async function cacheAudioResponse(url, response) {
  if (!("caches" in window)) return;
  try {
    const c = await caches.open(AUDIO_CACHE);
    await c.put(url, response);
  } catch {
    /* quota exceeded / unavailable — playback falls back to the backend */
  }
}
async function fetchAudioBytes(url) {
  if ("caches" in window) {
    try {
      const c = await caches.open(AUDIO_CACHE);
      const hit = await c.match(url);
      if (hit) return await hit.arrayBuffer();
    } catch {
      /* fall through to the network */
    }
  }
  const r = await apiFetch(url);
  if (!r.ok) throw new Error("audio fetch failed");
  cacheAudioResponse(url, r.clone()); // populate for next time / for resume
  return await r.arrayBuffer();
}
async function evictAudio(url) {
  if (!("caches" in window)) return;
  try {
    const c = await caches.open(AUDIO_CACHE);
    await c.delete(url);
  } catch {
    /* noop */
  }
}
async function clearAudioCache() {
  if (!("caches" in window)) return;
  try {
    await caches.delete(AUDIO_CACHE);
  } catch {
    /* noop */
  }
}

// fetch() that turns an unreachable-backend network error into a clear, actionable
// message instead of the browser's cryptic "Failed to fetch".
async function apiFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch {
    throw new Error(`Can't reach the backend at ${API} — is it running?`);
  }
}

// ---- One deck (a single playable track) --------------------------------------
class Deck {
  constructor(ctx, destination, id, engine) {
    this.ctx = ctx;
    this.id = id;
    this.engine = engine;

    this.trim = ctx.createGain(); // volume matching (per-track loudness trim)
    this.gain = ctx.createGain(); // per-deck volume
    this.fade = ctx.createGain(); // crossfader contribution
    // 3-band EQ for bass-swap transitions: source -> low -> mid -> high -> gain.
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = "lowshelf";
    this.eqLow.frequency.value = 250;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = "peaking";
    this.eqMid.frequency.value = 1500;
    this.eqMid.Q.value = 0.8;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = "highshelf";
    this.eqHigh.frequency.value = 4000;
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.trim);
    this.trim.connect(this.gain);

    this.gain.connect(this.fade);
    this.fade.connect(destination); // -> master

    this.buffer = null;
    this.meta = null; // { title, duration, thumbnail, uploader, bpm, offset }
    this.baseBpm = null; // detected BPM at playbackRate 1
    this.source = null;
    this.shifter = null; // SoundTouch PitchShifter when key-lock is on
    this._stPos = 0; // last reported track time (key-lock position)
    this._stPosCtx = 0; // ctx time of that report
    this.isPlaying = false;
    this.playbackRate = 1;
    this.volume = 1;
    this.cue = 0; // cue point (buffer seconds)

    this._startCtxTime = 0; // ctx time when current source started
    this._startOffset = 0; // buffer position (s) at that start
    this.onEnded = null;
  }

  load(buffer, meta) {
    this.stop();
    this.buffer = buffer;
    this.meta = meta;
    this.baseBpm = meta?.bpm ?? null;
    this.playbackRate = 1;
    this._startOffset = 0;
    this.isPlaying = false;
    this.cue = 0;
    this.resetEq();
    this.applyTrim();
  }

  // Volume matching: bring each track to the same perceived loudness (LUFS).
  applyTrim() {
    const db = this.engine?.volumeMatch ? matchGainDb(this.meta?.lufs) : 0;
    this.trim.gain.value = 10 ** (db / 20);
  }

  // Current playback position in buffer-seconds.
  position() {
    if (!this.buffer) return 0;
    if (this.shifter) {
      if (!this.isPlaying) return this._stPos;
      const t = this._stPos + (this.ctx.currentTime - this._stPosCtx) * this.playbackRate;
      return Math.min(Math.max(0, t), this.buffer.duration);
    }
    if (!this.isPlaying) return this._startOffset;
    // Clamp elapsed to >=0: a beat-aligned start can be scheduled slightly in the
    // future, which would otherwise make position() read before _startOffset.
    const elapsed = Math.max(0, this.ctx.currentTime - this._startCtxTime) * this.playbackRate;
    return Math.min(this._startOffset + elapsed, this.buffer.duration);
  }

  remaining() {
    if (!this.buffer) return 0;
    return (this.buffer.duration - this.position()) / this.playbackRate; // real seconds
  }

  _makeSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.playbackRate;
    src.connect(this.eqLow);
    src.onended = () => {
      if (src === this.source && this.isPlaying) {
        this.isPlaying = false;
        this._startOffset = this.buffer.duration;
        this.source = null;
        if (this.onEnded) this.onEnded(this);
      }
    };
    return src;
  }

  // Start playing. `atCtxTime` lets the auto-mixer start on a precise beat.
  play(atCtxTime = null, fromOffset = null) {
    if (!this.buffer || this.isPlaying) return;
    const offset = fromOffset != null ? fromOffset : this._startOffset;
    const when = atCtxTime != null ? atCtxTime : this.ctx.currentTime;
    if (this.engine && this.engine.keyLock) {
      this._playKeyLock(Math.max(0, offset), when);
    } else {
      const src = this._makeSource();
      src.start(when, Math.max(0, offset));
      this.source = src;
      this._startCtxTime = when;
      this._startOffset = offset;
    }
    this.isPlaying = true;
  }

  // Pitch-preserving playback via SoundTouch. There's no start(when), so for a
  // future (beat-aligned) start we connect on a timer — ms-accurate, fine here.
  _playKeyLock(offset, when) {
    const shifter = new PitchShifter(this.ctx, this.buffer, 8192);
    shifter.tempo = this.playbackRate;
    shifter.pitch = 1.0;
    if (this.buffer.duration > 0) {
      shifter.percentagePlayed = Math.min(0.999, offset / this.buffer.duration);
    }
    this._stPos = offset;
    this._stPosCtx = this.ctx.currentTime;
    this._startOffset = offset;
    shifter.on("play", (d) => {
      this._stPos = d.timePlayed;
      this._stPosCtx = this.ctx.currentTime;
      // SoundTouch reports "playing" forever after the audio is exhausted; detect the
      // end ourselves so a manual key-locked deck flips isPlaying and fires onEnded.
      if (
        this.shifter === shifter &&
        this.isPlaying &&
        this.buffer &&
        d.timePlayed >= this.buffer.duration - 0.05
      ) {
        this.isPlaying = false;
        this._stPos = this.buffer.duration;
        try {
          shifter.disconnect();
        } catch {
          /* noop */
        }
        try {
          if (shifter._node) shifter._node.onaudioprocess = null;
        } catch {
          /* noop */
        }
        this.shifter = null;
        if (this.onEnded) this.onEnded(this);
      }
    });
    this.shifter = shifter;
    const delay = when - this.ctx.currentTime;
    const connect = () => {
      if (this.shifter === shifter) shifter.connect(this.eqLow);
    };
    if (delay > 0.02) setTimeout(connect, delay * 1000);
    else connect();
  }

  pause() {
    if (!this.isPlaying) return;
    const pos = this.position();
    this.stop();
    this._startOffset = pos;
    this._stPos = pos;
  }

  stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        this.source.disconnect();
      } catch {
        /* noop */
      }
      this.source = null;
    }
    if (this.shifter) {
      try {
        this.shifter.off && this.shifter.off();
      } catch {
        /* noop */
      }
      try {
        this.shifter.disconnect();
      } catch {
        /* noop */
      }
      // Null the ScriptProcessor handler so the (deprecated) node can be GC'd —
      // disconnect() alone leaves it alive on the audio thread.
      try {
        if (this.shifter._node) this.shifter._node.onaudioprocess = null;
      } catch {
        /* noop */
      }
      this.shifter = null;
    }
    this.isPlaying = false;
  }

  seek(offset) {
    const wasPlaying = this.isPlaying;
    this.stop();
    this._startOffset = Math.max(0, Math.min(offset, this.buffer ? this.buffer.duration : 0));
    if (wasPlaying) this.play();
  }

  setVolume(v) {
    this.volume = v;
    this.gain.gain.value = v; // direct write (reliable; scheduling proved flaky)
  }

  // EQ in dB: 0 = flat, -40 ≈ kill. Direct writes (scheduling proved flaky).
  setEq(band, db) {
    const node = band === "low" ? this.eqLow : band === "mid" ? this.eqMid : this.eqHigh;
    node.gain.value = db;
  }
  resetEq() {
    this.eqLow.gain.value = 0;
    this.eqMid.gain.value = 0;
    this.eqHigh.gain.value = 0;
  }

  // Change tempo while keeping the playhead continuous.
  setPlaybackRate(rate) {
    rate = Math.max(0.5, Math.min(2, rate));
    if (this.isPlaying) {
      const pos = this.position();
      if (this.shifter) {
        this._stPos = pos;
        this._stPosCtx = this.ctx.currentTime;
        this.shifter.tempo = rate;
      } else if (this.source) {
        this._startOffset = pos;
        this._startCtxTime = this.ctx.currentTime;
        this.source.playbackRate.value = rate;
      }
    }
    this.playbackRate = rate;
  }

  get effectiveBpm() {
    return this.baseBpm ? this.baseBpm * this.playbackRate : null;
  }
}

// ---- The engine (owns both decks + crossfader + master) ----------------------
export class Engine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.deckA = null;
    this.deckB = null;
    this.crossfade = 0; // 0 = full A, 1 = full B
    this.onChange = null; // UI re-render hook
    this.playlist = []; // analyzed, decoded tracks (the party set)
    this.transitions = []; // per-adjacent-pair transition quality (after ordering)
    this.keyLock = false; // pitch-preserving tempo (SoundTouch) when true
    this.autoOrder = true; // slot each added track into its best spot (no API key needed)
    this.volumeMatch = true; // play every track at the same loudness
    this._txn = 0; // transition generation; stale transition timers no-op
    this.resumable = null; // {idx} if a crashed set can be resumed (set by _restoreSession)
    this._wakeLock = null; // Screen Wake Lock sentinel held while a set runs
    this._saveT = null; // debounce handle for session persistence
    // Create the context + decks up front so the UI always has decks to read.
    // It starts "suspended" (no user gesture yet) and resumes on first load/play.
    this._ensure();
    this.auto = new AutoMix(this); // hands-free auto-mixer (defined below)
    this._restoreSession(); // re-hydrate a previous (possibly interrupted) set
  }

  _ensure() {
    if (this.ctx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    // Safety limiter: volume-matched boosts and overlapping blends must never clip.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.deckA = new Deck(ctx, this.master, "A", this);
    this.deckB = new Deck(ctx, this.master, "B", this);
    this.applyCrossfade(this.crossfade);
  }

  async resume() {
    this._ensure();
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  deck(which) {
    return which === "A" ? this.deckA : this.deckB;
  }

  other(which) {
    return which === "A" ? this.deckB : this.deckA;
  }

  emit() {
    if (this.onChange) this.onChange();
  }

  // ---- Crash recovery: persist the set (playlist metadata + position) ----------
  saveSession() {
    try {
      const playlist = this.playlist.map((t) => {
        // eslint-disable-next-line no-unused-vars -- destructured only to strip the un-serializable bits
        const { buffer, _decoding, ...meta } = t;
        return meta;
      });
      if (!playlist.length) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          playlist,
          idx: this.auto.active ? this.auto.idx : 0,
          loop: this.auto.loop,
          transitionSecs: this.auto.transitionSecs,
          autoOrder: this.autoOrder,
          volumeMatch: this.volumeMatch,
          party: this.auto.party,
          active: this.auto.active,
          ts: Date.now(),
        })
      );
    } catch {
      /* quota / private mode / unavailable — best-effort */
    }
  }
  _saveSoon() {
    if (this._saveT) return;
    this._saveT = setTimeout(() => {
      this._saveT = null;
      this.saveSession();
    }, 800);
  }
  clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* noop */
    }
  }
  _restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.playlist) || !data.playlist.length) return;
      this.playlist = data.playlist.map((t) => ({ ...t, buffer: null }));
      this._recomputeTransitions();
      this.auto.loop = !!data.loop;
      if (data.transitionSecs) this.auto.transitionSecs = data.transitionSecs;
      if (typeof data.autoOrder === "boolean") this.autoOrder = data.autoOrder;
      if (typeof data.volumeMatch === "boolean") this.volumeMatch = data.volumeMatch;
      if (typeof data.party === "boolean") this.auto.party = data.party;
      // Only offer to resume if a set was actually mid-play when it died.
      if (data.active) {
        this.resumable = { idx: Math.max(0, Math.min(data.idx || 0, this.playlist.length - 1)) };
      }
    } catch {
      /* corrupt session — ignore */
    }
  }

  // ---- Keep the machine awake during an unattended set -------------------------
  async requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !this._wakeLock) {
        this._wakeLock = await navigator.wakeLock.request("screen");
        this._wakeLock.addEventListener("release", () => {
          this._wakeLock = null;
        });
      }
    } catch {
      /* not granted / unsupported — the set still runs */
    }
  }
  async releaseWakeLock() {
    try {
      if (this._wakeLock) {
        const w = this._wakeLock;
        this._wakeLock = null;
        await w.release();
      }
    } catch {
      /* noop */
    }
  }

  // Backend /api/load (download + convert + key/energy) -> fetch audio -> decode
  // -> client-side BPM + beat offset. Returns a full track object.
  async _fetchAndDecode(url) {
    return this._decodeMeta(await this._loadMeta(url), url);
  }

  async _loadMeta(url) {
    this._ensure();
    await this.resume();
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await apiFetch(`${API}/api/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (res.status === 503 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500)); // transient network — back off + retry
        continue;
      }
      break;
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `Load failed (${res.status})`);
    }
    return await res.json(); // {id,title,duration,thumbnail,uploader,audioUrl,key,camelot,energy,...}
  }

  // Fetch + decode an analyzed track's audio, then detect tempo and refine the key.
  async _decodeMeta(meta, url) {
    this._ensure();
    const fullAudioUrl = `${API}${meta.audioUrl}`;
    const audioRes = await apiFetch(fullAudioUrl);
    if (!audioRes.ok) throw new Error("Could not fetch audio");
    // Cache the compressed bytes (so later plays + a post-crash resume don't need the
    // backend), then decode a copy for analysis.
    await cacheAudioResponse(fullAudioUrl, audioRes.clone());
    const arr = await audioRes.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(arr);

    let bpm = null;
    let offset = 0;
    try {
      const g = await guess(buffer); // { bpm, offset }
      bpm = Math.round(g.bpm);
      offset = g.offset;
    } catch {
      /* tempo not detectable — leave null */
    }
    // Refine the key with essentia.js (more accurate than the backend K-S fallback,
    // especially major vs minor). Falls back to the backend key if it fails.
    let key = meta.key;
    let camelot = meta.camelot;
    const k = await detectKey(buffer);
    if (k && k.camelot) {
      key = k.key;
      camelot = k.camelot;
    }
    return { url, ...meta, buffer, bpm, offset, key, camelot };
  }

  // Manual: load a URL straight into a deck.
  async loadUrlToDeck(which, url) {
    const track = await this._fetchAndDecode(url);
    this.deck(which).load(track.buffer, track);
    this.emit();
    return track;
  }

  // ---- Playlist ----
  // Works mid-set too. With autoOrder the track goes to its best harmonic/tempo spot;
  // otherwise to the end of the queue. Existing tracks never move (manual order stays).
  async addTrack(url) {
    return this._insert(await this._fetchAndDecode(url));
  }
  // A track the backend already downloaded + analyzed (a friend's party request).
  async addAnalyzed(meta) {
    return this._insert(await this._decodeMeta(meta, meta.url));
  }
  _insert(track) {
    // Analysis is done; drop the decoded PCM (~80 MB) so memory stays flat over a
    // long set. It's re-decoded on demand (the backend keeps the mp3 for the session).
    track.buffer = null;
    const [lo, hi] = this._upcomingRange();
    const p = this.autoOrder ? bestInsertIndex(this.playlist, track, lo, hi) : hi;
    this._reorder((list) => list.splice(p, 0, track));
    return track;
  }

  // The part of the playlist that can still be rearranged, as [lo, hi): everything
  // after the playing track and the preloaded next one (the whole list before a set).
  _upcomingRange() {
    const n = this.playlist.length;
    const a = this.auto;
    if (!a.active) return [0, n];
    const next = a._nextIdx();
    if (next > a.idx) return [Math.min(next + 1, n), n];
    return [next + 1, Math.max(next + 1, a.idx)]; // looping set has wrapped
  }

  // Party session: net votes per track id. Songs at DROP_AT or below are dropped; the
  // rest of the upcoming queue is ordered by votes (see voteOrder).
  applyVotes(scores) {
    for (const t of this.playlist) t.score = scores[t.id] || 0;
    for (const t of this.playlist.filter((x) => x.score <= DROP_AT)) this.removeTrack(t.id);
    const [lo, hi] = this._upcomingRange();
    return this._reorder((list) => {
      const ordered = voteOrder(list[lo - 1] || null, list.slice(lo, hi), (t) => t.score, {
        smooth: this.autoOrder,
      });
      list.splice(lo, hi - lo, ...ordered);
    });
  }

  // What friends' phones show: now playing, mixing in next, and the rest in play order.
  partySnapshot() {
    const brief = (t) =>
      t && {
        id: t.id,
        title: t.title,
        uploader: t.uploader ?? null,
        thumbnail: t.thumbnail ?? null,
        addedBy: t.addedBy ?? null,
        camelot: t.camelot ?? null,
        bpm: t.bpm ?? null,
        genre: t.genre ?? null,
      };
    const a = this.auto;
    const [lo, hi] = this._upcomingRange();
    const upcoming = this.playlist.slice(lo, hi).map(brief);
    const info = a.nowInfo();
    if (!info) return { playing: false, now: null, next: null, upcoming };
    return {
      playing: true,
      now: brief(info.track),
      next: brief(info.next),
      upcoming,
      // phones animate the progress bar between syncs from this
      progress: { pos: info.pos, dur: info.dur, mixAt: info.mixAt, mixing: info.transitioning },
    };
  }

  // Apply a playlist edit, keeping the auto-mixer's position on the same track object.
  // Mid-blend, the incoming track must stay next (the handoff advances to "next"), so
  // an edit that would change it is refused. Returns whether the edit was applied.
  _reorder(edit) {
    const a = this.auto;
    const before = this.playlist.slice();
    const current = a.active ? before[a.idx] : null;
    const incoming = a.active && a._transitioning ? before[a._nextIdx()] : null;
    const list = before.slice();
    edit(list);
    if (current && !list.includes(current)) return false; // never drop the playing track
    this.playlist = list;
    if (current) {
      a.idx = list.indexOf(current);
      if (incoming && list[a._nextIdx()] !== incoming) {
        this.playlist = before;
        a.idx = before.indexOf(current);
        return false;
      }
    }
    this._recomputeTransitions();
    this._saveSoon();
    this.emit();
    return true;
  }
  setVolumeMatch(on) {
    this.volumeMatch = on;
    this.deckA.applyTrim();
    this.deckB.applyTrim();
    this.saveSession();
    this.emit();
  }

  // Each track's analysis as plain data (the "Copy song data" button) — for checking
  // how detection behaves on real songs.
  songData() {
    const blend = this.auto.transitionSecs;
    return this.playlist.map((t) => {
      const dur = t.loudness?.length || t.duration || null;
      return {
        title: t.title,
        uploader: t.uploader,
        url: t.url,
        duration: dur,
        bpm: t.bpm,
        key: t.key,
        camelot: t.camelot,
        energy: t.energy,
        genre: t.genre ?? null,
        lufs: t.lufs ?? null,
        gainDb: matchGainDb(t.lufs),
        introEnd: t.introEnd,
        outroStart: t.outroStart,
        bigParts: t.bigParts ?? null,
        partyMixOut: partyMixOut(t.bigParts, dur, { blend }),
        loudness: t.loudness ?? null, // smoothed dB per second
      };
    });
  }

  // Locked = can't be moved/removed right now: the playing track, and mid-blend the
  // incoming one.
  isLocked(id) {
    const a = this.auto;
    if (!a.active) return false;
    const t = this.playlist[a.idx];
    const inc = a._transitioning ? this.playlist[a._nextIdx()] : null;
    return t?.id === id || inc?.id === id;
  }
  moveTrack(id, to) {
    return this._reorder((list) => {
      const i = list.findIndex((t) => t.id === id);
      if (i < 0) return;
      const [t] = list.splice(i, 1);
      list.splice(Math.max(0, Math.min(to, list.length)), 0, t);
    });
  }
  // Queue a track right after the one playing (or first, if no set is running).
  playNext(id) {
    const a = this.auto;
    const current = a.active ? this.playlist[a.idx] : null;
    return this._reorder((list) => {
      const i = list.findIndex((t) => t.id === id);
      if (i < 0 || list[i] === current) return;
      const [t] = list.splice(i, 1);
      list.splice(current ? list.indexOf(current) + 1 : 0, 0, t);
    });
  }

  // Decode a playlist track's audio on demand (we don't keep ~90 buffers in RAM).
  ensureDecoded(track) {
    if (!track) return Promise.resolve(null);
    if (track.buffer) return Promise.resolve(track.buffer);
    if (!track._decoding) {
      track._decoding = (async () => {
        const bytes = await fetchAudioBytes(`${API}${track.audioUrl}`); // client cache first
        const buf = await this.ctx.decodeAudioData(bytes);
        track.buffer = buf;
        return buf;
      })().finally(() => {
        track._decoding = null;
      });
    }
    return track._decoding;
  }
  freeDecoded(track) {
    if (track) track.buffer = null;
  }
  removeTrack(id) {
    const t = this.playlist.find((x) => x.id === id);
    if (!t || this.isLocked(id)) return false;
    const ok = this._reorder((list) => list.splice(list.indexOf(t), 1));
    if (ok) evictAudio(`${API}${t.audioUrl}`);
    return ok;
  }
  clearPlaylist() {
    this.playlist = [];
    this.transitions = [];
    this.resumable = null;
    clearAudioCache();
    this.clearSession();
    this.emit();
  }
  _recomputeTransitions() {
    const t = [];
    for (let i = 0; i < this.playlist.length - 1; i++)
      t.push(transitionQuality(this.playlist[i], this.playlist[i + 1]));
    this.transitions = t;
  }
  // Smart algorithmic ordering (Camelot + BPM + energy arc).
  orderPlaylist(opts) {
    const { ordered, transitions } = orderForParty(this.playlist, opts);
    this.playlist = ordered;
    this.transitions = transitions;
    this._saveSoon();
    this.emit();
    return { ordered, transitions };
  }
  // Apply an externally-decided order (e.g. from the LLM) by track id.
  reorderByIds(ids) {
    const byId = new Map(this.playlist.map((t) => [t.id, t]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const t of this.playlist) if (!ids.includes(t.id)) ordered.push(t);
    this.playlist = ordered;
    this._recomputeTransitions();
    this._saveSoon();
    this.emit();
  }
  // Apply the LLM's [{id, genre}] result: reorder + tag each track's genre.
  applyAiOrder(ordered) {
    const genre = {};
    const ids = [];
    for (const o of ordered) {
      ids.push(o.id);
      genre[o.id] = o.genre;
    }
    this.reorderByIds(ids);
    for (const t of this.playlist) if (genre[t.id]) t.genre = genre[t.id];
    this._saveSoon();
    this.emit();
  }

  // ---- Transport ----
  play(which) {
    this._ensure();
    this.deck(which).play();
    this.emit();
  }
  pause(which) {
    this.deck(which).pause();
    this.emit();
  }
  togglePlay(which) {
    const d = this.deck(which);
    d.isPlaying ? this.pause(which) : this.play(which);
  }
  seek(which, offset) {
    this.deck(which).seek(offset);
    this.emit();
  }
  setCue(which) {
    const d = this.deck(which);
    d.cue = d.position();
    this.emit();
  }
  jumpCue(which) {
    const d = this.deck(which);
    d.seek(d.cue || 0);
    this.emit();
  }
  setTempo(which, rate) {
    this.deck(which).setPlaybackRate(rate);
    this.emit();
  }
  setVolume(which, v) {
    this.deck(which).setVolume(v);
    this.emit();
  }
  setMaster(v) {
    this._ensure();
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }
  setKeyLock(on) {
    if (this.auto && this.auto.active) return; // ignore during an auto-set (manual decks only)
    this.keyLock = !!on; // applies to decks the next time they start
    this.emit();
  }

  // ---- Crossfader (equal power) ----
  // Driven by direct `.value` writes (ramps animated on a JS timer). AudioParam
  // scheduling (setValueAtTime/setTargetAtTime) proved unreliable — a param could
  // wedge and ignore scheduled events — whereas direct writes always apply.
  _setFadeGains(x) {
    this.deckA.fade.gain.value = Math.cos(x * 0.5 * Math.PI);
    this.deckB.fade.gain.value = Math.cos((1 - x) * 0.5 * Math.PI);
  }
  _stopXfRamp() {
    if (this._xfTimer) {
      clearInterval(this._xfTimer);
      this._xfTimer = null;
    }
  }
  applyCrossfade(x) {
    this._stopXfRamp();
    this._setFadeGains(x);
  }
  setCrossfade(x) {
    this._ensure();
    this.crossfade = Math.max(0, Math.min(1, x));
    this.applyCrossfade(this.crossfade);
    this.emit();
  }
  // Smoothly ramp the crossfader to `target` over `seconds` (JS-timed).
  rampCrossfade(target, seconds) {
    this._ensure();
    this._stopXfRamp();
    const from = this.crossfade;
    const start = performance.now();
    const durMs = Math.max(1, seconds * 1000);
    this._xfTimer = setInterval(() => {
      const f = Math.min(1, (performance.now() - start) / durMs);
      const x = from + (target - from) * f;
      this._setFadeGains(x);
      this.crossfade = x;
      if (f >= 1) {
        this._stopXfRamp();
        this.crossfade = target;
        this._setFadeGains(target);
        this.emit();
      }
    }, 30);
  }

  // ---- Beat sync ----
  // Match `which` deck's tempo (and, if a reference beat is given, phase) to the
  // other deck. Returns the ctx time of the other deck's next beat (for aligned starts).
  nextBeatTime(which) {
    const d = this.deck(which);
    if (!d.baseBpm || !d.isPlaying) return this.ctx.currentTime;
    const beatBuf = 60 / d.baseBpm; // seconds-per-beat in buffer time
    const sinceOffset = d.position() - (d.meta.offset || 0);
    const beats = sinceOffset / beatBuf;
    const toNext = (Math.ceil(beats) - beats) * beatBuf; // buffer seconds
    const toNextReal = toNext / d.playbackRate;
    return this.ctx.currentTime + toNextReal;
  }

  // Ctx time of the deck's next bar (4-beat) boundary — for phrase alignment.
  nextBarTime(which) {
    const d = this.deck(which);
    if (!d.baseBpm || !d.isPlaying) return this.ctx.currentTime;
    const barBuf = (60 / d.baseBpm) * 4;
    const sinceOffset = d.position() - (d.meta.offset || 0);
    const toNext = Math.ceil(sinceOffset / barBuf) * barBuf - sinceOffset;
    return this.ctx.currentTime + Math.max(0, toNext) / d.playbackRate;
  }

  syncTempo(which) {
    const target = this.deck(which);
    const ref = this.other(which);
    if (!target.baseBpm || !ref.baseBpm) return false;
    const rate = (ref.baseBpm * ref.playbackRate) / target.baseBpm;
    target.setPlaybackRate(rate);
    this.emit();
    return true;
  }

  // Start `which` deck beat-aligned to the other (used by sync-start & auto-mix).
  startSynced(which) {
    const target = this.deck(which);
    const ref = this.other(which);
    if (target.baseBpm && ref.baseBpm) {
      const rate = (ref.baseBpm * ref.playbackRate) / target.baseBpm;
      target.setPlaybackRate(rate);
    }
    const when = ref.isPlaying ? this.nextBeatTime(ref.id) : this.ctx.currentTime;
    const fromOffset = target.meta?.offset || 0; // begin on its first downbeat
    target.play(when, fromOffset);
    this.emit();
  }

  // Phrase-aligned, beat-matched transition with an EQ bass-swap. The incoming
  // deck starts on the front deck's next bar with its lows cut, the volume
  // crossfades equal-power, and the bass is swapped at the midpoint so two
  // basslines never clash. Returns the total seconds until the handoff completes.
  startTransition(fromFront, back, secs) {
    const txn = ++this._txn; // any timer tagged with an older txn is now stale
    const front = this.deck(fromFront);
    const inc = this.deck(back);

    // Boundary-aware: too big a tempo gap to beat-match (or a genre change with a
    // real gap) -> clean cut instead of force-stretching.
    const gap = bpmDistance(front.baseBpm, inc.baseBpm);
    const genreChange =
      front.meta?.genre && inc.meta?.genre && front.meta.genre !== inc.meta.genre;
    if (gap > 0.08 || (genreChange && gap > 0.04)) {
      return this._cutTransition(fromFront, back, txn);
    }

    // Beat-match the incoming deck to the front deck's effective tempo.
    if (front.baseBpm && inc.baseBpm) {
      inc.setPlaybackRate((front.baseBpm * front.playbackRate) / inc.baseBpm);
    }
    const beatReal = front.baseBpm ? 60 / front.baseBpm / front.playbackRate : 0.5;

    // Snap the blend to whole bars (8–32 beats).
    let blendBeats = Math.round(secs / beatReal / 4) * 4;
    blendBeats = Math.max(8, Math.min(32, blendBeats || 16));
    const blendReal = blendBeats * beatReal;

    // Start the incoming track on the front deck's next bar, entering with lows
    // (and some mids) cut so the basslines don't collide (intro-under-outro).
    const startAt =
      front.baseBpm && front.isPlaying ? this.nextBarTime(fromFront) : this.ctx.currentTime;

    // Start the incoming track at its first drop (skip a long/quiet intro), snapped
    // to its own bar grid so it stays beat-aligned with the front deck.
    let inOffset = inc.meta?.introEnd || 0;
    if (inc.baseBpm) {
      const bar = (60 / inc.baseBpm) * 4;
      const o = inc.meta?.offset || 0;
      inOffset = o + Math.max(0, Math.round((inOffset - o) / bar)) * bar;
    } else {
      inOffset = inc.meta?.offset || 0;
    }
    inc.setEq("low", -40);
    inc.setEq("mid", -6);
    inc.setEq("high", 0);
    inc.play(startAt, inOffset);

    const startDelay = Math.max(0, startAt - this.ctx.currentTime);
    setTimeout(() => {
      if (this._txn === txn) this._runBlend(fromFront, back, blendReal, txn);
    }, startDelay * 1000);
    return startDelay + blendReal;
  }

  _runBlend(fromFront, back, blendReal, txn) {
    const front = this.deck(fromFront);
    const inc = this.deck(back);
    // Equal-power volume crossfade across the blend.
    this.rampCrossfade(back === "B" ? 1 : 0, blendReal);
    // Bass swap at the midpoint: cut outgoing lows, open incoming lows + mids.
    setTimeout(() => {
      if (this._txn !== txn) return; // a newer transition started — don't touch these decks
      front.setEq("low", -40);
      inc.setEq("low", 0);
      inc.setEq("mid", 0);
    }, blendReal * 0.5 * 1000);
    // Leave the outgoing deck's EQ flat again for its next use.
    setTimeout(() => {
      if (this._txn === txn) front.resetEq();
    }, blendReal * 1000 + 80);
  }

  // Clean phrase cut for big BPM/genre gaps: no force-beatmatch. The incoming
  // plays at its own tempo, entering at its drop on the outgoing's next bar while
  // the outgoing is filtered (bass/mids pulled) + faded out fast.
  _cutTransition(fromFront, back, txn) {
    const front = this.deck(fromFront);
    const inc = this.deck(back);
    inc.setPlaybackRate(1);

    const startAt =
      front.baseBpm && front.isPlaying ? this.nextBarTime(fromFront) : this.ctx.currentTime;
    let inOffset = inc.meta?.introEnd || 0;
    if (inc.baseBpm) {
      const bar = (60 / inc.baseBpm) * 4;
      const o = inc.meta?.offset || 0;
      inOffset = o + Math.max(0, Math.round((inOffset - o) / bar)) * bar;
    } else {
      inOffset = inc.meta?.offset || 0;
    }
    inc.setEq("low", 0);
    inc.setEq("mid", 0);
    inc.setEq("high", 0);
    inc.play(startAt, inOffset);

    const cutSecs = 2.5;
    const startDelay = Math.max(0, startAt - this.ctx.currentTime);
    setTimeout(() => {
      if (this._txn !== txn) return; // a newer transition started — leave these decks alone
      front.setEq("low", -40);
      front.setEq("mid", -18);
      this.rampCrossfade(back === "B" ? 1 : 0, cutSecs);
    }, startDelay * 1000);
    return startDelay + cutSecs;
  }
}

// ---- Hands-free auto-mixer ----------------------------------------------------
// Walks a queue of URLs: plays the front deck, preloads the next track into the
// idle deck, and fires a beat-synced crossfade as the front track nears its end,
// then rotates decks and continues.
class AutoMix {
  constructor(engine) {
    this.engine = engine;
    this.idx = -1; // index of the front-deck track in the playlist
    this.front = "A";
    this.active = false;
    this.transitionSecs = 16;
    this.status = "idle"; // idle | playing | transitioning | done
    this._watch = null;
    this._transitioning = false;
    this._finalize = null; // pending handoff finalizer (run by timer OR watchdog)
    this._deadline = 0; // ctx time by which a transition must be finalized
    this.loop = false; // when true, wrap back to the start at the end (never stop)
    this.party = true; // mix out after each track's big moment instead of at its outro
  }

  get tracks() {
    return this.engine.playlist;
  }

  _set(status) {
    if (status) this.status = status;
    this.engine.emit();
  }

  _isBad(i) {
    const t = this.tracks[i];
    return !t || (t._fails || 0) >= 3; // 3 failed decodes -> skip this track entirely
  }
  // The next non-bad track index — wraps when looping, else n if none remain.
  _nextIdx() {
    const n = this.tracks.length;
    if (!n) return 0;
    if (this.loop) {
      for (let k = 1; k <= n; k++) {
        const j = (this.idx + k) % n;
        if (j !== this.idx && !this._isBad(j)) return j;
      }
      return (this.idx + 1) % n; // everything else is bad — fall back
    }
    for (let j = this.idx + 1; j < n; j++) if (!this._isBad(j)) return j;
    return n;
  }
  _hasNext() {
    const n = this.tracks.length;
    if (this.loop) {
      for (let i = 0; i < n; i++) if (i !== this.idx && !this._isBad(i)) return true;
      return false;
    }
    return this._nextIdx() < n;
  }
  // The back deck is "ready" only when it actually holds the expected next track. A
  // failed/zero load leaves a STALE buffer from a prior track, which a bare !buffer
  // check would mistake for "ready" and transition into.
  _backReady() {
    const back = this.engine.other(this.front);
    const t = this.tracks[this._nextIdx()];
    return !!(t && back.buffer && back.meta && back.meta.id === t.id);
  }

  // Load an already-decoded playlist track into a deck.
  _loadDeck(deckId, idx) {
    const t = this.tracks[idx];
    if (!t || !t.buffer) return false;
    const deck = this.engine.deck(deckId);
    if (deck.buffer === t.buffer) return true; // already loaded
    if (deck.isPlaying) return false; // never yank a live deck (throttle-reorder safety)
    deck.load(t.buffer, t);
    return true;
  }

  // Ensure track[idx] is decoded, then load it into a deck. Frees far buffers so
  // memory stays flat (~3 decoded tracks) over a 6-hour set.
  async _prepareAndLoad(deckId, idx) {
    const t = this.tracks[idx];
    if (!t) return;
    try {
      await this.engine.ensureDecoded(t);
    } catch {
      t._fails = (t._fails || 0) + 1; // after a few, _nextIdx() skips this track entirely
      return;
    }
    if (this.active && t.buffer) this._loadDeck(deckId, idx);
    this._freeFar();
  }

  _freeFar() {
    const n = this.tracks.length;
    const prev = this.loop ? (this.idx - 1 + n) % n : this.idx - 1;
    const keep = new Set([prev, this.idx, this._nextIdx()]); // decode window
    const a = this.engine.deckA.buffer;
    const b = this.engine.deckB.buffer;
    for (let i = 0; i < n; i++) {
      const t = this.tracks[i];
      if (t.buffer && !keep.has(i) && t.buffer !== a && t.buffer !== b) {
        this.engine.freeDecoded(t);
      }
    }
  }

  async start(startIdx = 0) {
    if (this.active || this.tracks.length === 0) return;
    this.active = true;
    this.idx = Math.max(0, Math.min(startIdx | 0, this.tracks.length - 1));
    this.front = "A";
    this._transitioning = false;
    this._finalize = null;
    this.engine.resumable = null; // we're live now
    this.engine.keyLock = false; // auto-mix beat-matches; key-lock is a manual-deck feature
    this.engine.requestWakeLock(); // keep the machine awake for the set
    await this.engine.resume();
    try {
      await this.engine.ensureDecoded(this.tracks[this.idx]);
    } catch {
      this.active = false;
      this.engine.releaseWakeLock();
      this._set("idle");
      return;
    }
    if (!this._loadDeck("A", this.idx)) {
      this.active = false;
      this.engine.releaseWakeLock();
      this._set("idle");
      return;
    }
    this.engine.setCrossfade(0);
    this.engine.play("A");
    this._set("playing");
    this.engine.deckA.onEnded = (d) => this._onEnded(d);
    this.engine.deckB.onEnded = (d) => this._onEnded(d);
    if (this._hasNext()) this._prepareAndLoad("B", this._nextIdx()); // decode + preload next
    this.engine.saveSession();
    this._startWatch();
  }

  _onEnded(deck) {
    if (!this.active || this._transitioning) return;
    if (deck !== this.engine.deck(this.front)) return; // only the front deck ending matters
    if (!this._hasNext()) {
      this._finish();
      return;
    }
    const back = this.engine.other(this.front);
    if (!this._backReady()) {
      this._prepareAndLoad(back.id, this._nextIdx()); // not ready (decoding/bad) — _tick retries
      return;
    }
    this._beginTransition(back, 4); // cut straight into the next track
  }

  stop() {
    this.active = false;
    this._transitioning = false;
    this._finalize = null;
    this._clearWatch();
    this.engine._txn++; // invalidate any pending transition timers so they no-op
    this.engine._stopXfRamp();
    this.engine.deckA.onEnded = null;
    this.engine.deckB.onEnded = null;
    // Stop means stop: silence both decks and reset their EQ/crossfader cleanly.
    this.engine.deckA.stop();
    this.engine.deckB.stop();
    this.engine.deckA.resetEq();
    this.engine.deckB.resetEq();
    this.engine.setCrossfade(0);
    this.engine.releaseWakeLock();
    this.engine.clearSession(); // intentional stop — nothing to resume
    this._set("idle");
  }

  _startWatch() {
    this._clearWatch();
    this._watch = setInterval(() => this._tick(), 250);
  }
  _clearWatch() {
    if (this._watch) {
      clearInterval(this._watch);
      this._watch = null;
    }
  }

  _tick() {
    if (!this.active) return;
    // Watchdog: a transition must never hang. If the finalize timer was dropped or
    // throttled past its deadline, finalize it here (the watch is the authority).
    if (this._transitioning) {
      if (this._finalize && this.engine.ctx.currentTime > this._deadline) {
        const f = this._finalize;
        this._finalize = null;
        f();
      }
      return;
    }
    const front = this.engine.deck(this.front);
    if (!front.buffer) return;
    // Self-heal: the front deck must always be playing during a set.
    if (!front.isPlaying && front.position() < front.buffer.duration - 1) {
      this.engine.play(this.front);
      return;
    }
    const back = this.engine.other(this.front);
    const hasNext = this._hasNext();
    const ended = !front.isPlaying && front.position() >= front.buffer.duration - 0.05;

    if (!hasNext) {
      if (ended || front.remaining() <= 0.25) this._finish();
      return;
    }
    if (!this._backReady()) {
      this._prepareAndLoad(back.id, this._nextIdx()); // decode/replace the next track ahead of time
      return;
    }
    const mixOutAt = this.mixOutPoint(front);

    if (ended) this._beginTransition(back, 4);
    else if (front.isPlaying && front.position() >= mixOutAt) this._beginTransition(back, this.transitionSecs);
  }

  // Seconds into the front track at which the blend into the next one starts.
  mixOutPoint(front = this.engine.deck(this.front)) {
    if (!front.buffer) return null;
    const dur = front.buffer.duration;

    // Mix OUT at the detected outro, but early enough that the blend finishes before
    // the track ends. Avoid mixing out into a mid-song breakdown (step back to groove).
    let mixOutAt = front.meta?.outroStart;
    if (!(mixOutAt > 0)) mixOutAt = dur;
    mixOutAt = Math.max(1, Math.min(mixOutAt, dur - this.transitionSecs));
    const curve = front.meta?.energyCurve;
    if (curve && curve.length) {
      let ci = Math.max(0, Math.min(curve.length - 1, Math.floor((mixOutAt / dur) * curve.length)));
      if (curve[ci] < 0.45) {
        for (let i = ci; i >= 0; i--) {
          if (curve[i] >= 0.55) {
            mixOutAt = (i / curve.length) * dur;
            break;
          }
        }
      }
    }

    if (this.party) {
      const p = partyMixOut(front.meta?.bigParts, dur, { blend: this.transitionSecs });
      if (p != null && p < mixOutAt) mixOutAt = p;
    }
    return mixOutAt;
  }

  // The DJ's override: start blending into the next track now (it still lands on a bar).
  mixNow() {
    if (!this.active || this._transitioning || !this._backReady()) return false;
    this._beginTransition(this.engine.other(this.front), this.transitionSecs);
    return true;
  }

  // What's playing, for the Now Playing view and friends' phones.
  nowInfo() {
    if (!this.active) return null;
    const front = this.engine.deck(this.front);
    const track = this.tracks[this.idx] || null;
    return {
      track,
      next: this._hasNext() ? this.tracks[this._nextIdx()] : null,
      pos: front.position(),
      dur: front.buffer?.duration || track?.duration || 0,
      mixAt: this.mixOutPoint(front),
      transitioning: this._transitioning,
      canMixNow: !this._transitioning && this._backReady(),
    };
  }

  _beginTransition(back, secs) {
    if (!back || !back.buffer) return; // never transition to an empty deck
    const total = this.engine.startTransition(this.front, back.id, secs);
    this._afterTransition(total);
  }

  _afterTransition(secs) {
    this._transitioning = true;
    this._set("transitioning");
    const fromFront = this.front;
    const back = fromFront === "A" ? "B" : "A";
    this._deadline = this.engine.ctx.currentTime + secs + 4;
    // Finalize the handoff deterministically (run by the timer OR the watchdog,
    // whichever fires first) and ALWAYS clear the guard, even if a line throws.
    const finalize = () => {
      if (!this.active) {
        this._transitioning = false;
        return; // stopped/finished mid-transition — nothing to hand off
      }
      try {
        this.engine.deck(fromFront).stop();
        this.engine.deck(fromFront).resetEq();
        this.engine.deck(back).resetEq();
        this.engine.setCrossfade(back === "B" ? 1 : 0);
        this.front = back;
        this.idx = this._nextIdx();
        this.engine._saveSoon(); // persist the new position for crash recovery
        this._set("playing");
        if (this._hasNext()) this._prepareAndLoad(fromFront, this._nextIdx()); // load following track
      } catch {
        /* never wedge the set */
      } finally {
        this._transitioning = false;
      }
    };
    this._finalize = finalize;
    setTimeout(() => {
      if (this._finalize === finalize) {
        this._finalize = null;
        finalize();
      }
    }, secs * 1000);
  }

  _finish() {
    this.active = false;
    this._transitioning = false;
    this._finalize = null;
    this._clearWatch();
    this.engine.deckA.onEnded = null;
    this.engine.deckB.onEnded = null;
    this.engine.releaseWakeLock();
    this.engine.clearSession(); // finished cleanly — nothing to resume
    this._set("done");
  }
}
