"""Lightweight track analysis: musical key (-> Camelot) + energy (1-10).

Decodes audio to PCM with ffmpeg (already a dependency) and uses numpy/scipy —
no heavy MIR libraries. Key is found by Krumhansl-Schmuckler profile correlation
on an FFT chromagram; energy from loudness + spectral brightness. Approximate but
good enough for harmonic/energy-aware set ordering. BPM + beat offset are computed
client-side (web-audio-beat-detector), so we don't duplicate them here.
"""

import subprocess

import numpy as np
from scipy.signal import stft

SR = 22050

# Krumhansl-Schmuckler key profiles (major / natural minor), tonic at index 0.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

_PITCH = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# Camelot codes by pitch class (C=0). Major = B ring, minor = A ring.
_CAMELOT_MAJ = {0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B",
                6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B"}
_CAMELOT_MIN = {9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A", 8: "1A",
                3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A", 2: "7A"}


def _decode(path: str) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
    )
    return np.frombuffer(out.stdout, dtype=np.float32)


def _chromagram(y: np.ndarray) -> np.ndarray:
    f, _, Z = stft(y, fs=SR, nperseg=8192, noverlap=8192 - 2048)
    mag = np.log1p(np.abs(Z))     # log compression -> reduce loud-bass/transient dominance
    freqs = f[1:]                 # drop DC bin
    M = mag[1:]
    midi = 69 + 12 * np.log2(np.maximum(freqs, 1e-9) / 440.0)
    pc = np.mod(np.round(midi).astype(int), 12)
    band = (freqs > 65) & (freqs < 2500)  # fundamental pitch range
    chroma = np.zeros((12, M.shape[1]))   # per-frame chroma
    for i in np.where(band)[0]:
        chroma[pc[i]] += M[i]
    chroma /= chroma.sum(axis=0) + 1e-9   # normalize each frame (equal contribution)
    chroma = chroma.mean(axis=1)
    s = chroma.sum()
    return chroma / s if s > 0 else chroma


def _detect_key(chroma: np.ndarray):
    best_corr, best_tonic, best_mode = -2.0, 0, "maj"
    for tonic in range(12):
        cmaj = np.corrcoef(np.roll(_MAJOR, tonic), chroma)[0, 1]
        cmin = np.corrcoef(np.roll(_MINOR, tonic), chroma)[0, 1]
        if np.isfinite(cmaj) and cmaj > best_corr:
            best_corr, best_tonic, best_mode = cmaj, tonic, "maj"
        if np.isfinite(cmin) and cmin > best_corr:
            best_corr, best_tonic, best_mode = cmin, tonic, "min"
    if best_corr <= -1.0:  # no real correlation (silent/constant chroma) -> unknown
        return None, None
    name = f"{_PITCH[best_tonic]} {'major' if best_mode == 'maj' else 'minor'}"
    camelot = (_CAMELOT_MAJ if best_mode == "maj" else _CAMELOT_MIN)[best_tonic]
    return name, camelot


def _energy(y: np.ndarray) -> int:
    """Dance-floor energy 1-10 from gain-invariant features (so mastering loudness
    doesn't dominate): onset/percussive density + low-band (kick/bass) ratio +
    beat-pulse strength + a small brightness term. See research notes."""
    f, _, Z = stft(y, fs=SR, nperseg=2048, noverlap=2048 - 512)
    S = np.abs(Z)
    if S.shape[1] < 8:
        return 5
    P = S ** 2

    # Onset strength: half-wave-rectified spectral flux, normalized by frame
    # magnitude (gain-invariant). Mean = how busy/percussive the track is.
    diff = np.maximum(0.0, S[:, 1:] - S[:, :-1])
    frame_mag = S[:, :-1].sum(axis=0) + 1e-9
    onset_env = diff.sum(axis=0) / frame_mag
    onset_density = float(onset_env.mean())

    # Low-frequency (kick/bass, 30-150 Hz) share of total energy.
    low = P[(f >= 30) & (f < 150)].sum(axis=0)
    bass_ratio = float((low / (P.sum(axis=0) + 1e-9)).mean())

    # Beat-pulse strength: autocorrelation peak of the onset envelope in a
    # plausible beat-lag window (~0.25-1.0 s), relative to zero lag.
    oe = onset_env - onset_env.mean()
    ac = np.correlate(oe, oe, mode="full")[len(oe) - 1:]
    hop_t = 512 / SR
    lo, hi = max(1, int(0.25 / hop_t)), min(len(ac) - 1, int(1.0 / hop_t))
    pulse = float(ac[lo:hi].max() / (ac[0] + 1e-9)) if hi > lo else 0.0

    # Brightness (demoted): spectral centroid.
    centroid = float((f[:, None] * P).sum() / (P.sum() + 1e-9))

    f_onset = np.clip(onset_density * 6.0, 0, 1)
    f_bass = np.clip(bass_ratio * 2.5, 0, 1)
    f_pulse = np.clip(pulse * 2.0, 0, 1)
    f_bright = np.clip((centroid - 500) / 3500, 0, 1)

    raw = 0.35 * f_onset + 0.30 * f_bass + 0.20 * f_pulse + 0.15 * f_bright
    return int(round(np.clip(1 + 9 * raw, 1, 10)))


def _structure(y: np.ndarray) -> dict:
    """Estimate intro-end and outro-start (seconds) from the RMS energy envelope,
    so the mixer can skip long/quiet intros and mix out at the outro instead of
    playing dead tails. Heuristic: 'loud' = sustained energy near the track's peak;
    intro-end = first sustained-loud point, outro-start = last sustained-loud point."""
    dur = float(y.size / SR)
    win = int(0.5 * SR)
    n = y.size // win
    if n < 8:
        return {"introEnd": 0.0, "outroStart": round(dur, 2), "energyCurve": []}
    rms = np.array([np.sqrt(np.mean(y[i * win:(i + 1) * win] ** 2)) for i in range(n)])
    rms = np.convolve(rms, np.ones(3) / 3, mode="same")  # smooth ~1.5s
    peak = np.percentile(rms, 90) + 1e-9
    loud = rms > 0.45 * peak
    need = 4  # ~2s sustained to count as "the groove"

    introEnd = 0.0
    for i in range(n - need):
        if loud[i:i + need].all():
            introEnd = i * 0.5
            break
    outroStart = dur
    for i in range(n, need, -1):
        if loud[i - need:i].all():
            outroStart = i * 0.5
            break

    if introEnd > dur * 0.4:  # implausibly long intro -> ignore
        introEnd = 0.0
    if outroStart < dur * 0.5 or outroStart >= dur or outroStart <= introEnd:
        outroStart = dur  # no clear outro -> mixer falls back to blend-before-end

    # Downsampled, normalized energy curve (~100 pts) so the mixer can spot
    # mid-song breakdowns and avoid mixing out into one.
    norm = np.clip(rms / peak, 0, 1)
    if n > 100:
        norm = norm[(np.arange(100) * n / 100).astype(int)]
    curve = [round(float(v), 2) for v in norm]
    return {"introEnd": round(introEnd, 2), "outroStart": round(outroStart, 2), "energyCurve": curve}


def analyze(path: str) -> dict:
    """Return {key, camelot, energy, introEnd, outroStart}. Never raises."""
    nulls = {"key": None, "camelot": None, "energy": None, "introEnd": 0.0,
             "outroStart": 0.0, "energyCurve": []}
    try:
        y = _decode(path)
        if y.size < SR:  # decode failed or clip too short
            return nulls
        structure = _structure(y)  # needs the FULL track (intro at start, outro at end)
        ymid = y
        if y.size > SR * 120:  # key/energy on a representative ~90s middle window
            mid = y.size // 2
            ymid = y[mid - SR * 45: mid + SR * 45]
        name, camelot = _detect_key(_chromagram(ymid))
        return {"key": name, "camelot": camelot, "energy": _energy(ymid), **structure}
    except Exception:
        return nulls
