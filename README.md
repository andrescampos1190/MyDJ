# 🎧 MyDJ — AI-sequenced party auto-mixer

Build a playlist from track URLs, let it **order the set for a party**, and play it
back **hands-free with real DJ transitions** — beat-matched, harmonically ordered,
EQ bass-swapped, never an abrupt ending. Everything runs in the browser's audio
engine; **nothing is saved to your computer.**

```
React + Web Audio API                         FastAPI                yt-dlp + ffmpeg
  decks · crossfader · 3-band EQ               /api/load  (download + convert +
  beatmatch · phrase-aligned EQ-swap            key/energy analysis)
  transitions · playlist · ordering            /api/audio/{id} (stream to browser)
  (localhost:5173)                             /api/order (optional Claude ordering)
```

## What it does
- **Analyzes every track**: musical key → **Camelot** code, **BPM** + beat offset, **energy**.
- **Orders the playlist for a party**: harmonic mixing (Camelot), small BPM steps, and an
  energy arc (warm-up → peak → wind-down). Two ways:
  - **🎚 Order for Party** — built-in algorithm (instant, free, no API key).
  - **✨ AI Polish** — Claude sequences/explains it (needs `ANTHROPIC_API_KEY`).
- **Mixes hands-free** with correct transitions: phrase/bar-aligned, **beat-matched**,
  **equal-power crossfade**, **3-band EQ bass-swap** (incoming enters with lows cut, bass
  swaps at the midpoint), and a deterministic clean handoff (never leaves a deck muted).
- Manual two-deck + crossfader controls are still there for hands-on mixing — each deck
  shows a **waveform** (click to seek) with a settable **cue** point.
- **🔒 Key-lock toggle**: pitch-preserving tempo (SoundTouch time-stretch) so beatmatching
  doesn't "chipmunk" the pitch. Off by default (see notes).

## Prerequisites
Python 3.12+ · ffmpeg + ffprobe on PATH · Node 20.19+ (or 22.12+)
Python deps: `fastapi`, `uvicorn`, `yt-dlp`, `deno` (the JS runtime yt-dlp needs for
YouTube), `numpy`, `scipy`, `anthropic` (see `backend/requirements.txt`).
Node deps: `react`, `vite`, `web-audio-beat-detector`, `soundtouchjs` (key-lock),
`essentia.js` (key detection — AGPL-3.0, fine for local/personal use).

## First-time setup (from the project root)
**Windows (PowerShell):**
```powershell
python -m venv backend\venv
backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
npm install --prefix frontend
```
**macOS / Linux:**
```bash
python3 -m venv backend/venv
backend/venv/bin/python -m pip install -r backend/requirements.txt
npm install --prefix frontend
```
Already have a venv from before? Re-run the `pip install` line — it adds `deno`, without
which yt-dlp can't solve YouTube's JS challenges and YouTube tracks fail to load.

## Run it (two terminals, from the project root)
**Backend** (no `--reload` — see note):
```powershell
backend\venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --port 8000
```
(macOS/Linux: `backend/venv/bin/python -m uvicorn main:app --app-dir backend --port 8000`)
On Windows, `.\start.ps1` launches both in one go.
**Frontend:**
```powershell
npm run dev --prefix frontend
```
Open **http://localhost:5173**.

> ⚠️ **Don't run uvicorn with plain `--reload` here.** It watches the whole project,
> including `backend/venv/`, so installing a package mid-run triggers a reload storm that
> can kill the server. For dev auto-reload, scope it: `--reload --reload-exclude "*/venv/*"`.

### Optional: AI Polish (Claude ordering)
Set your key **before** starting the backend, then the ✨ AI Polish button works:
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # then start uvicorn in the same terminal
```
Without the key, AI Polish returns a friendly "set ANTHROPIC_API_KEY" message; the
algorithmic **Order for Party** works regardless. Model: `claude-opus-4-8` (change in
`backend/llm_order.py`).

## How to use
1. Paste track URLs into the **Playlist** box → **+ Add** (each is downloaded + analyzed; you'll
   see its BPM / Camelot key / energy chips).
2. **🎚 Order for Party** (or **✨ AI Polish**) to sequence the set. The badges between tracks
   show each transition's quality (perfect / good / ok / rough, with BPM%, key-match, energy step).
3. Set the **Blend** length (toggle **🔁 Loop** if you want it to never end — it wraps back to the
   start) and hit **▶ Start Set**. It plays through, transitioning automatically; **⏹ Stop** ends it
   and silences both decks cleanly.

## How it works
- **Analysis** (`backend/analyzer.py`): ffmpeg → PCM, an FFT chromagram + Krumhansl–Schmuckler
  profile matching for key (→ Camelot), and loudness/brightness for energy. BPM + beat offset are
  computed client-side with `web-audio-beat-detector`.
- **Ordering** (`frontend/src/ordering.js`): Camelot compatibility + BPM distance (half/double-time
  aware) + an energy-arc cost, greedy from a low-energy opener. `backend/llm_order.py` is the
  optional Claude path (`messages.parse` with a Pydantic schema → validated id order).
- **Engine** (`frontend/src/audioEngine.js`): each deck = source → 3-band EQ → volume → crossfade →
  master. Transitions snap to the front deck's next bar, beat-match the incoming deck
  (`playbackRate`), crossfade equal-power, swap the bass at the midpoint, and snap the handoff clean.

## Built to run unattended (6-hour set)
- **Flat memory** — only the current + next track are decoded (~3 buffers); played tracks are freed,
  so a 90-track night uses the same memory as a 6-track one.
- **Backend-independent playback** — each track's *compressed* audio is cached in the browser (Cache
  API) on load, so once a set is going it never needs the backend again; a backend restart can't stop
  the music.
- **Crash recovery** — the playlist + position are persisted (localStorage); reopen the tab after a
  crash and a **⟳ Resume from track N** prompt picks the set back up (audio replays from the cache).
- **Bad-track skip** — a track that fails to decode mid-set (removed/region-locked/corrupt) is retried
  a few times then skipped; one bad track never stalls the party.
- **Stays awake** — requests a Screen Wake Lock while a set runs so the display/machine won't sleep.
- **Self-healing transitions** — a watchdog finalizes every handoff off the audio clock, a resume-
  watchdog restarts a suspended AudioContext, and stale transition timers are invalidated by
  generation — so the set never stalls or goes silent, even in a throttled background tab.

## Known limitations / notes
- **Energy** uses onset/percussive density + low-band (kick/bass) ratio + beat-pulse strength
  (brightness demoted) — much better for dance tracks than the old loudness+treble heuristic,
  though still an estimate. Tune the weights in `analyzer.py:_energy`.
- **Key detection** runs client-side via **essentia.js** (HPCP-based) on the decoded buffer,
  with the backend's Krumhansl-Schmuckler as a fallback. More accurate (gets major/minor right),
  but no detector is perfect — genuinely ambiguous tracks can land on the relative major/minor
  (harmonically compatible anyway). First analysis loads ~2.5 MB of WASM (lazy, cached).
- **Beatmatch:** default uses `playbackRate` (slight pitch shift — subtle for the small BPM
  steps good ordering produces). Flip **🔒 Key-lock** on for pitch-preserving time-stretch
  (SoundTouch). Key-lock is a **manual-deck** feature — the hands-free auto-mixer forces it off,
  since SoundTouch's main-thread ScriptProcessor isn't suited to an unattended multi-hour set.
- **Phrasing is a 4/4 bar grid** off the detected beat offset (true downbeat detection isn't reliable
  in-browser) — great for dance/pop, approximate for free-time music.
- **Background tabs:** audio keeps playing, but browsers throttle JS timers, so a *smooth* blend
  can stutter. The set still advances and never stalls — a watchdog finalizes each handoff off the
  audio clock (not a wall-clock timer), a self-heal resumes the front deck if it's ever left stopped,
  and an AudioContext resume-watchdog restarts audio if the browser suspends it (sleep/background).
  Keep the tab foregrounded for the smoothest blends; you don't have to for reliability.
- **Occasional yt-dlp 403** on a specific video — shown on the track; retry or update yt-dlp. A
  failed mid-set track decode is skipped, not fatal — the set continues.
- **Memory is bounded for long (6-hour) sets.** Per-track analysis (BPM/key/energy/structure) is
  kept, but the large decoded audio is held for only the current + next track; played tracks are
  freed and re-decoded from the server on demand. Steady-state memory stays flat (~3 tracks) whether
  the set is 6 tracks or 6 hours, instead of growing until the tab runs out of memory and crashes.

## Deploy to Render (Docker)
The repo ships a [`Dockerfile`](Dockerfile) (Python + ffmpeg) and a [`render.yaml`](render.yaml)
blueprint for the backend + static frontend.
1. **New → Blueprint** in Render, point it at this repo — it creates `mydj-backend` (Docker) and
   `mydj-frontend` (static Vite build).
2. After the first deploy, set the two cross-referencing URLs and redeploy each:
   - backend `ALLOWED_ORIGINS` = `https://<your-frontend>.onrender.com`
   - frontend `VITE_API_URL` = `https://<your-backend>.onrender.com` (baked in at build time)
   - backend `ANTHROPIC_API_KEY` (optional, enables AI Polish)
3. Backend health-check path is `/api/health`. The free tier (512 MB) may OOM on
   download+ffmpeg+analysis — move to a paid instance if it does.

> ⚠️ **Two realities of cloud-hosting a yt-dlp app:** (1) YouTube frequently **blocks datacenter
> IPs** (Render/AWS/…) with a bot check, so downloads that work from home often fail in the cloud;
> (2) it's an **open, no-auth downloader** — anyone with the URL can drive your server. Built for
> personal use; deploy at your own risk.

## Stretch ideas
Stem-based transitions · ML-based energy/danceability · drag-to-reorder · save/record the mix ·
hot cues (multiple cue points) · Rubberband/Superpowered for higher-quality key-lock.
