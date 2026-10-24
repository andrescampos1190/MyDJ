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
  - **🪄 Auto-order** (on by default, no key) — each song you add is slotted into its best
    spot; songs already in the list never move, so your manual order is kept.
- **Live queue**: add songs while a set is playing, **⏭ Next** to play one next, **▲▼** to
  reorder, **✕** to drop one. The playing track (and, mid-blend, the incoming one) is locked.
- **🔥 Party mode** (on by default): mixes out over the tail of each song's first big part
  (chorus/drop) that ends after 1 min, instead of playing it to the end — no second verses or
  long outros. Big parts are the loudest ~30% of the song *relative to itself* (per-second
  loudness smoothed over ~7 s), so loudly mastered songs work too. No clear structure → leaves
  ~60% in; never more than 2:45 per song.
- **🔊 Volume match** (on by default): every song plays at the same perceived loudness (EBU R128
  LUFS, measured on load), with a safety limiter on the output so nothing clips.
- **📋 Copy song data**: copies each song's analysis (tempo, key, loudness curve, big parts, where
  Party mode will mix out) as text — handy for checking how detection does on real songs.
- **Genre** from the source's metadata (site genre field, uploader tags, title) — free; AI
  Polish can still label the rest.
- **Mixes hands-free like a club DJ** (`frontend/src/mixPlan.js` plans each transition):
  - **Precise beat grids** (backend, to ~0.01 BPM + downbeat) — beat-matched blends stay within
    ~1 ms over 32 beats (tested), where whole-BPM tempos would drift ~50 ms (an audible flam).
  - **Phrasing + drop on the one:** blends are whole phrases (8/16/32 beats) starting on
    downbeats; the outgoing song leaves as its chorus ends (Party mode) or across its outro, and
    the incoming song is timed so **its drop lands exactly when the old one is gone** — the
    overlap sits under the incoming intro, not two choruses at once.
  - **Style per pair** (shown in Now Playing, e.g. "8-bar blend into the drop"):
    - **EQ blend** — bass cut on the incoming, **bass swap on a bar line**, outgoing loses
      mids/highs as it leaves. Two singers never overlap: with both songs split into stems the
      **vocals swap on a bar line** (below); otherwise two vocal songs blend at most 4 bars.
    - **Filter sweep** — on a genre change, a big energy jump or a key clash: the incoming comes
      in high-passed and opens up while the outgoing is low-passed away.
    - **Double drop** — two electronic tracks in compatible keys and near-equal tempos: both
      drops hit on the same downbeat, then the old track leaves 4 bars later.
    - **Cut on the one** — a vocal track with no intro to blend over: the outgoing's last beat
      feeds a short echo and the new song slams in on the downbeat.
    - **Echo out** — tempos >8% apart: tempo-synced echo tail, the incoming drops on the
      downbeat at its own tempo.
    - **Fade** — only when there's no reliable beat grid.
  - **Vocal stems + vocal swap:** each added song is split into vocals + instrumental in the
    background (an MDX-Net vocal model run with onnxruntime — ~1 min per song on a laptop CPU;
    the queue shows "🎤 splitting vocals 40%"). The mixer then knows exactly where each song's
    vocals are, and the decks play the two stems sample-locked, so mid-blend the outgoing
    vocal drops out on the bar line where the incoming singer comes in. A song can be played
    before it's split — until then the mixer goes by its genre.
  - **Intro loop:** a song whose intro is too short to blend over (e.g. 2 bars before the drop)
    gets its intro looped, on the beat, until the drop is due.
  - **Key shift:** when two neighbours' keys clash and a one-semitone move fixes it (+1 semitone
    = +7 on the Camelot wheel), the incoming song is pitched ±1 semitone — the backend renders the
    copy with ffmpeg's Rubber Band filter (formants preserved), so the tempo and beat grid don't
    move. Without Rubber Band in your ffmpeg build it falls back to a plain resample.
  - **Sample-accurate:** fades, EQ moves, echo and bass swap are scheduled on the audio clock,
    not JS timers — they land on the beat even in a busy or background tab.
  - **Tempo glides back:** after a beat-matched handoff the new song returns to its own tempo
    (and pitch) at ~0.2%/s, so the set never drifts off the songs' real speeds.
- Manual two-deck + crossfader controls are still there for hands-on mixing — each deck
  shows a **waveform** (click to seek) with a settable **cue** point.
- **🔒 Key-lock toggle**: pitch-preserving tempo (SoundTouch time-stretch) so beatmatching
  doesn't "chipmunk" the pitch. Off by default (see notes).

## Prerequisites
Python 3.12+ · ffmpeg + ffprobe on PATH · Node 20.19+ (or 22.12+)
Python deps: `fastapi`, `uvicorn`, `yt-dlp`, `deno` (the JS runtime yt-dlp needs for
YouTube), `numpy`, `scipy`, `onnxruntime` (vocal separation), `anthropic` (see
`backend/requirements.txt`). The vocal model (~65 MB) downloads into `backend/models/` the
first time a song is split; separating takes ~1.5 GB of RAM while it runs.
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
backend\venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --host 0.0.0.0 --port 8000
```
(macOS/Linux: `backend/venv/bin/python -m uvicorn main:app --app-dir backend --host 0.0.0.0 --port 8000`)
`--host 0.0.0.0` lets phones on your Wi-Fi reach it for the party session; without it, only this
computer can.
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

## Tests
Everything runs offline against synthesized tracks with known keys (needs ffmpeg).
```bash
# backend: analyzer (key/energy/structure) + API (download → convert → analyze → stream)
backend/venv/bin/python -m pip install -r backend/requirements-dev.txt
cd backend && venv/bin/python -m pytest          # Windows: venv\Scripts\python.exe -m pytest

# frontend: lint + ordering unit tests
npm run lint --prefix frontend && npm test --prefix frontend

# browser end-to-end: starts backend + frontend + a local media server, adds tracks,
# orders them, starts a set, and checks audio plays and auto-transitions to track 2 — plus
# each transition style (beat alignment measured against the test songs' true grids)
cd frontend && npx playwright install chromium && npm run test:e2e
```
Real YouTube/SoundCloud downloads are covered by `backend/tests/test_live.py`, which only
runs with `MYDJ_LIVE=1` (it needs internet). GitHub Actions (`.github/workflows/ci.yml`) runs
all of the above on every push, plus a Docker build check and the live tests.

## How to use
The screen is laid out for a hands-free set: **Now Playing** on top, the **Queue** below it,
**Party session** and **Set options** on the side, and **Manual decks** (two decks, crossfader,
cue points) folded away at the bottom for mixing by hand.
1. In the Queue, **search a song by name** (top YouTube results → **+ Add**) or **paste a link**.
   Each song is downloaded and analyzed (tempo, key, energy, loudness, big parts). With
   **🪄 Auto-order** on, each lands in its best spot automatically.
2. Optionally **🎚 Order for Party** (full re-sequence with an energy arc) or **✨ AI Polish**. The
   line between songs shows each transition's quality (perfect / good / ok / rough).
3. Hit **▶ Start set** (top right). Now Playing shows the song, a waveform with the mix-out point
   marked, and "Mixing into *next song* in 0:28". **⏭ Mix now** starts the blend early when the
   floor gets bored; **■ Stop** ends the set and silences both decks cleanly.
4. During the set, keep adding songs; use **⏭ Next** / **▲▼** / **✕** to steer the queue. **NOW**
   and **NEXT** tags show what's playing and what's mixing in next.
5. **Set options:** Blend length, 🪄 Auto-order, 🔥 Party mode, 🔊 Volume match, 🔁 Loop, and
   📋 Copy song data.

## Party session (friends add songs and vote from their phones)
1. Start the app as usual (`.\start.ps1`). The backend and frontend now listen on your home
   network too. **The first time, Windows asks whether to allow Python and Node.js through the
   firewall — allow them on Private networks**, or phones can't connect.
2. In the app's **📱 Party session** card, click **Start party session**. A QR code and a link like
   `http://192.168.1.23:5173/guest` appear.
3. Friends on the **same Wi-Fi** scan the code, type their name once, then:
   - **search** for a song by name (top YouTube results) or **paste a link**, and tap **＋ Add** —
     it's confirmed at once and shows under "On the way" while it downloads (usually 10–30 s);
   - **▲ / ▼ vote** on anything queued (tap again to take a vote back).
4. How the queue reacts:
   - **Votes win, the mix stays smooth:** songs with more net votes play sooner; among songs with
     equal votes, auto-order picks the best-mixing order (or keeps your manual order if
     **🪄 Auto-order** is off).
   - A song at **-3** net votes is dropped.
   - The song playing and the one already mixing in never move.
   - You can still reorder/remove on the DJ screen; votes re-sort the queue whenever they change.
   - Friends' songs show who added them (👤) and their votes (▲ / ▼).

### Phones can't connect?
The DJ's party panel shows a live checklist: whether the music server and the app answer on your
network, and which phones are connected — once a phone shows up there, it's working. Phones show
a status bar too (connected / lost connection / can't reach the music server). If a phone can't
open the link or join:
- It must be on the **same Wi-Fi** as the computer — not mobile data, and not a "guest" Wi-Fi
  (those usually stop devices from seeing each other).
- **Windows Firewall:** Start → "Allow an app through Windows Firewall" → Change settings → tick
  **Private** for **Node.js JavaScript Runtime** and **Python**.
- Your Wi-Fi must be a **Private** network: Settings → Network & internet → Wi-Fi → your network →
  Network profile type → Private.
- Turn off VPNs. If the panel lists more than one address, try the others (Windows can have
  virtual adapters, e.g. from WSL or Hyper-V).

> Anyone on your Wi-Fi can open the party page and add songs. It's meant for your home network;
> don't port-forward it to the internet.

## How it works
- **Analysis** (`backend/analyzer.py`): ffmpeg → PCM, an FFT chromagram + Krumhansl–Schmuckler
  profile matching for key (→ Camelot), and loudness/brightness for energy. BPM + beat offset are
  computed client-side with `web-audio-beat-detector`.
- **Ordering** (`frontend/src/ordering.js`): Camelot compatibility + BPM distance (half/double-time
  aware) + an energy-arc cost, greedy from a low-energy opener. `backend/llm_order.py` is the
  optional Claude path (`messages.parse` with a Pydantic schema → validated id order).
- **Beat grid** (`backend/beatgrid.py`): onset envelope → coarse tempo by autocorrelation → fine
  search (0.005 BPM steps) folding the whole song onto each candidate period; downbeat = the beat
  phase with the most harmonic change. No steady beat → no grid (the mixer fades instead).
- **Stems** (`backend/stems.py`): ffmpeg → 44.1 kHz stereo → STFT chunks (~6 s, crossfaded) through
  the Kim_Vocal_2 MDX-Net model (onnxruntime) → vocal stem; instrumental = mix − vocals, so the
  two add back up to the song exactly. Vocal segments = where the vocal stem carries a real share
  of the sound. Runs in a low-priority child process (`StemJobs`), ordered by the playlist.
- **Engine** (`frontend/src/audioEngine.js`): each deck = source (or instrumental + vocal stems,
  the vocals through their own gain) → 3-band EQ → loudness trim →
  volume → crossfade → master (+ an echo send). `mixPlan.js` decides style, phrase timing and the
  drop landing; the engine schedules it on the audio clock and finishes the handoff.

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
- **Vocal separation** runs on the CPU at low priority, one song at a time, in the order the
  set needs them (~1 min per 3-minute song on a laptop; a busy machine is slower). Songs added
  right before they play may not be split in time and mix by genre instead. Separation is very
  good but not perfect: loud backing synths can leak a little into the vocal stem. Set
  `MYDJ_STEMS=0` to turn it off (e.g. on a low-RAM machine).
- **Section detection** (chorus/drop boundaries) is loudness-based, refined to the nearest
  downbeat: right for songs whose big parts are louder; a song that's flat all the way through has
  no "drop" to land, and blends instead.
- **Phrasing assumes 4/4 on a steady grid** — right for pop, reggaeton, hip-hop and electronic;
  live or free-time recordings get no grid and fall back to a fade.
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
   download+ffmpeg+analysis — move to a paid instance if it does. Vocal separation is off in
   the Docker image (`MYDJ_STEMS=0`); set `MYDJ_STEMS=1` on an instance with 2+ GB RAM.
4. **YouTube cookies** (needed for YouTube on Render — see below): on `mydj-backend` →
   Environment → **Secret Files**, add `cookies.txt`. The blueprint already points
   `YTDLP_COOKIES_FILE` at `/etc/secrets/cookies.txt`; without the file it's ignored.

### YouTube "Sign in to confirm you're not a bot"
YouTube bot-checks datacenter IPs (Render, AWS, GitHub Actions…), so YouTube tracks that load
fine from home fail in the cloud with this message. SoundCloud and others are unaffected.
The fix is to give yt-dlp a logged-in YouTube session as a `cookies.txt` (Netscape format):
1. Use a **throwaway Google account** — cookies used from a server can get an account flagged.
2. In a private/incognito window, log in to YouTube, export cookies for `youtube.com` with a
   "cookies.txt" browser extension, then close the window without logging out (so the session
   isn't rotated). Details: yt-dlp wiki → *Exporting YouTube cookies*.
3. Point the backend at it with `YTDLP_COOKIES_FILE=/path/to/cookies.txt` (Render: the Secret File
   above). The file is copied to a writable temp file, so read-only secret mounts are fine.
4. To have CI's live test check it, add the file's contents as a repo secret named `YTDLP_COOKIES`
   (GitHub → Settings → Secrets and variables → Actions).

Cookies expire or get rotated; when YouTube loads start failing again, re-export them.

> ⚠️ It's an **open, no-auth downloader** — anyone with the URL can drive your server (and your
> YouTube cookies). Built for personal use; deploy at your own risk.

## Stretch ideas
Acapella / instrumental mash-ups from the stems · ML-based energy/danceability · drag-to-reorder · save/record the mix ·
hot cues (multiple cue points) · Rubberband/Superpowered for higher-quality key-lock.
