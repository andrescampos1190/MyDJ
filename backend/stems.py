"""Vocal / instrumental stems, so the mixer knows where each song's vocals are and can
swap them on a bar line instead of letting two singers talk over each other.

Separation uses an MDX-Net vocal model (Kim_Vocal_2, from the Ultimate Vocal Remover
project) run with onnxruntime on the CPU. The model (~65 MB) downloads on first use.
A 3-minute song takes about a minute (and ~1.5 GB of RAM while it runs), so it runs in
the background, in a separate low-priority process, one song at a time: the music and
the app keep priority. MYDJ_STEMS=0 turns it off (the mixer then goes by genre).

Writes beside each track: {id}.vocals.mp3 and {id}.inst.mp3, where inst = mix - vocals,
so the two stems played together are the original song (sample-aligned to it).

    python stems.py song.mp3     # separate one file (used by the job runner)
"""

import importlib.util
import json
import os
import subprocess
import sys
import threading
import uuid

import numpy as np

MODEL_NAME = "Kim_Vocal_2.onnx"
MODEL_URL = os.environ.get("MYDJ_MODEL_URL") or (
    "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/" + MODEL_NAME
)
MODEL_DIR = os.environ.get("MYDJ_MODEL_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "models"
)

SR = 44100
NFFT = 7680  # the model's STFT: 3072 bins x 256 frames per chunk
HOP = 1024
DIM_F = 3072
DIM_T = 256
CHUNK = HOP * (DIM_T - 1)  # ~5.9 s
OVERLAP = CHUNK // 4  # chunks overlap and crossfade, hiding edge artifacts


def enabled() -> bool:
    """Stems are on unless MYDJ_STEMS=0 or onnxruntime isn't installed."""
    return os.environ.get("MYDJ_STEMS", "1") != "0" and importlib.util.find_spec("onnxruntime") is not None


def model_path() -> str:
    path = os.path.join(MODEL_DIR, MODEL_NAME)
    if os.path.isfile(path):
        return path
    import requests

    os.makedirs(MODEL_DIR, exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex}.part"
    with requests.get(MODEL_URL, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for block in r.iter_content(1 << 20):
                f.write(block)
    if os.path.getsize(tmp) < 10_000_000:
        os.remove(tmp)
        raise RuntimeError("model download was cut short")
    os.replace(tmp, path)
    return path


# ---- Separation ----------------------------------------------------------------

_WIN = np.hanning(NFFT + 1)[:-1].astype(np.float32)


def _stft(x: np.ndarray) -> np.ndarray:
    """(2, CHUNK) -> (2, NFFT/2+1, DIM_T), centered frames."""
    xp = np.pad(x, ((0, 0), (NFFT // 2, NFFT // 2)), mode="reflect")
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(DIM_T)[:, None]
    return np.fft.rfft(xp[:, idx] * _WIN, axis=-1).transpose(0, 2, 1)


def _istft(S: np.ndarray) -> np.ndarray:
    frames = np.fft.irfft(S.transpose(0, 2, 1), n=NFFT, axis=-1) * _WIN
    n = NFFT + HOP * (DIM_T - 1)
    out = np.zeros((2, n), np.float32)
    norm = np.zeros(n, np.float32)
    for t in range(DIM_T):
        out[:, t * HOP: t * HOP + NFFT] += frames[:, t]
        norm[t * HOP: t * HOP + NFFT] += _WIN ** 2
    out /= np.maximum(norm, 1e-8)
    return out[:, NFFT // 2: NFFT // 2 + CHUNK]


def _decode(path: str) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy()


def _encode(x: np.ndarray, out: str) -> None:
    tmp = f"{out}.{uuid.uuid4().hex}.tmp.mp3"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", "-",
         "-b:a", "192k", tmp],
        input=np.ascontiguousarray(x.T, dtype=np.float32).tobytes(), check=True, capture_output=True,
    )
    os.replace(tmp, out)  # atomic: a reader never sees a half-written stem


def separate_vocals(x: np.ndarray, progress=None) -> np.ndarray:
    """The vocal stem of stereo `x` (2, n) at 44.1 kHz."""
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) - 1)
    opts.enable_cpu_mem_arena = False  # peak ~1.4 GB instead of ~2.5 GB (and no slower)
    sess = ort.InferenceSession(model_path(), opts, providers=["CPUExecutionProvider"])
    n = x.shape[1]
    xp = np.pad(x, ((0, 0), (OVERLAP, OVERLAP + CHUNK)))
    step = CHUNK - OVERLAP
    ramp = np.linspace(0, 1, OVERLAP, dtype=np.float32)
    w = np.ones(CHUNK, np.float32)
    w[:OVERLAP], w[-OVERLAP:] = ramp, ramp[::-1]
    voc = np.zeros_like(xp)
    wsum = np.zeros(xp.shape[1], np.float32)
    starts = range(0, n + 2 * OVERLAP, step)
    for i, s in enumerate(starts):
        S = _stft(xp[:, s: s + CHUNK])[:, :DIM_F]
        out = sess.run(None, {"input": np.concatenate([S.real, S.imag])[None].astype(np.float32)})[0][0]
        full = np.zeros((2, NFFT // 2 + 1, DIM_T), np.complex64)
        full[:, :DIM_F] = out[:2] + 1j * out[2:]
        voc[:, s: s + CHUNK] += _istft(full) * w
        wsum[s: s + CHUNK] += w
        if progress:
            progress((i + 1) / len(starts))
    voc /= np.maximum(wsum, 1e-3)
    return voc[:, OVERLAP: OVERLAP + n]


def vocal_segments(voc: np.ndarray, mix: np.ndarray, frame: float = 0.25) -> list:
    """Where the vocals are: [[start, end], ...] in seconds."""
    hop = int(SR * frame)
    m = voc.shape[1] // hop
    if m == 0:
        return []
    rms = lambda a: np.sqrt((a[:, : m * hop].reshape(2, m, hop) ** 2).mean(axis=(0, 2)))
    v, x = rms(voc), rms(mix)
    on = (v > 0.2 * x) & (v > 10 ** (-45 / 20))  # a real share of the sound, not leakage
    on = np.convolve(on, np.ones(5), mode="same") >= 3  # smooth out single-frame blips
    segs = []
    i = 0
    while i < m:
        if on[i]:
            j = i
            while j < m and on[j]:
                j += 1
            segs.append([i * frame, j * frame])
            i = j
        else:
            i += 1
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < 1.5:  # a breath, not the end of a line
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [[round(a, 2), round(b, 2)] for a, b in merged if b - a >= 0.75]


def stem_paths(path: str) -> dict:
    base = path[:-4]
    return {"vocals": f"{base}.vocals.mp3", "inst": f"{base}.inst.mp3"}


def separate(path: str, progress=None) -> dict:
    """Write the track's vocal and instrumental stems; returns {"vocals": segments}."""
    x = _decode(path)
    voc = separate_vocals(x, progress)
    out = stem_paths(path)
    _encode(x - voc, out["inst"])
    _encode(voc, out["vocals"])
    return {"vocals": vocal_segments(voc, x)}


# ---- Background jobs -------------------------------------------------------------


def _low_priority():
    if sys.platform == "win32":
        return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS}
    return {"preexec_fn": lambda: os.nice(10)}


class StemJobs:
    """Separates tracks one at a time in a low-priority child process (a crash or a
    memory spike there can't take the server down). Pending tracks run in the order
    the DJ's playlist will need them (see prioritize)."""

    def __init__(self):
        self.jobs = {}  # id -> {"status", "progress", "vocals"?, "error"?}
        self.paths = {}
        self.order = []  # pending ids, most urgent first
        self.off_reason = None if enabled() else "off"
        self._cv = threading.Condition()
        self._thread = None

    def add(self, tid: str, path: str) -> str:
        with self._cv:
            if self.off_reason:
                return "off"
            if tid in self.jobs and self.jobs[tid]["status"] in ("queued", "running", "done"):
                return self.jobs[tid]["status"]
            self.jobs[tid] = {"status": "queued", "progress": 0.0}
            self.paths[tid] = path
            self.order.append(tid)
            if not self._thread:
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()
            self._cv.notify()
            return "queued"

    def prioritize(self, ids: list) -> None:
        with self._cv:
            rank = {t: i for i, t in enumerate(ids)}
            self.order.sort(key=lambda t: rank.get(t, len(rank)))

    def status(self, ids: list) -> dict:
        with self._cv:
            return {t: dict(self.jobs.get(t) or {"status": self.off_reason or "unknown"}) for t in ids}

    def _run(self):
        while True:
            with self._cv:
                while not self.order:
                    self._cv.wait()
                tid = self.order.pop(0)
                path = self.paths[tid]
                self.jobs[tid] = {"status": "running", "progress": 0.0}
            result = self._separate(tid, path)
            with self._cv:
                self.jobs[tid] = result
                if result.get("error") == "model":  # no model: nothing else can run either
                    self.off_reason = "unavailable"
                    for t in self.order:
                        self.jobs[t] = {"status": "unavailable"}
                    self.order.clear()

    def _separate(self, tid: str, path: str) -> dict:
        try:
            proc = subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), path],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, **_low_priority(),
            )
            done = None
            for line in proc.stdout:
                kind, _, rest = line.strip().partition(" ")
                if kind == "progress":
                    with self._cv:
                        self.jobs[tid]["progress"] = float(rest)
                elif kind == "done":
                    done = json.loads(rest)
                elif kind == "model-error":
                    proc.wait()
                    return {"status": "unavailable", "error": "model"}
            proc.wait()
            if proc.returncode == 0 and done is not None:
                return {"status": "done", "progress": 1.0, "vocals": done["vocals"]}
        except Exception:
            pass
        return {"status": "failed", "error": "separation failed"}


if __name__ == "__main__":
    try:
        model_path()
    except Exception:
        print("model-error", flush=True)
        sys.exit(2)
    res = separate(sys.argv[1], lambda p: print(f"progress {p:.3f}", flush=True))
    print("done " + json.dumps(res), flush=True)
