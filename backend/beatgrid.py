"""Precise beat grid: tempo (to ~0.01 BPM), beat phase, and downbeat.

Beat-matching two songs for 30+ seconds needs the tempo far more precisely than a
whole-BPM estimate: a 0.4 BPM error drifts ~100 ms over a 16 s blend — an audible
"flam". Produced music (pop, reggaeton, EDM, hip-hop) sits on a fixed grid, so we fold
the whole song's onset envelope onto candidate beat periods: at the true tempo every
beat lands in the same phase bin, so the fold is sharpest there.

The downbeat (the "1" of each bar) is where chords tend to change, so it's the beat
phase (of 4) with the most harmonic change.
"""

import numpy as np
from scipy.signal import stft

HOP = 128  # analysis hop in samples (~5.8 ms at 22050 Hz)
NFFT = 1024
# Peak flux lands slightly after the true onset; measured on synthetic kicks (see tests).
ONSET_LAG = -0.0064
BINS = 120  # phase bins per beat


def _onset_envelope(y: np.ndarray, sr: int):
    f, t, Z = stft(y, fs=sr, nperseg=NFFT, noverlap=NFFT - HOP, boundary=None, padded=False)
    S = np.log1p(np.abs(Z) * 20.0)
    flux = np.maximum(0.0, np.diff(S, axis=1))
    low = flux[f < 180].sum(axis=0)  # kick / bass hits
    full = flux.sum(axis=0)
    env = full / (full.max() + 1e-9) + low / (low.max() + 1e-9)
    # Remove the slowly varying level (keep the hits).
    k = int(0.4 * sr / HOP) | 1
    env = np.maximum(0.0, env - np.convolve(env, np.ones(k) / k, mode="same"))
    times = t[1:]  # flux between frame i and i+1 belongs to frame i+1
    return env, times, S, f


def _coarse_bpm(env: np.ndarray, fps: float) -> float | None:
    n = len(env)
    spec = np.fft.rfft(env - env.mean(), 2 * n)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    lo, hi = int(fps * 60 / 185), int(fps * 60 / 68)
    if hi >= n or lo < 1:
        return None
    lags = np.arange(lo, hi + 1)
    bpms = 60.0 * fps / lags
    # Gentle preference for typical dance tempos, so we don't pick half/double time.
    prior = np.exp(-0.5 * (np.log2(bpms / 118.0) / 0.55) ** 2)
    score = ac[lags] / (ac[0] + 1e-9) * prior
    i = int(np.argmax(score))
    # Parabolic refinement of the lag.
    if 0 < i < len(lags) - 1:
        a, b, c = score[i - 1], score[i], score[i + 1]
        d = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
        return 60.0 * fps / (lags[i] + d)
    return float(bpms[i])


def _fold(env, times, period):
    """Onset weight per phase bin when the song is folded at `period` seconds."""
    idx = ((times % period) / period * BINS).astype(int) % BINS
    return np.bincount(idx, weights=env, minlength=BINS)


def _best_phase(hist: np.ndarray) -> float:
    """Peak of a circular histogram, in fractions of a beat (with sub-bin refinement)."""
    sm = (np.roll(hist, 1) + 2 * hist + np.roll(hist, -1)) / 4
    i = int(np.argmax(sm))
    a, b, c = sm[(i - 1) % BINS], sm[i], sm[(i + 1) % BINS]
    d = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
    return ((i + d + 0.5) / BINS) % 1.0


def beat_grid(y: np.ndarray, sr: int) -> dict | None:
    """{"bpm", "beat": first beat time (s), "downbeat": first downbeat time (s),
    "confidence"} or None when there's no steady beat (ambient, speech, rubato)."""
    if y.size < sr * 10:
        return None
    env, times, S, f = _onset_envelope(y, sr)
    fps = sr / HOP
    coarse = _coarse_bpm(env, fps)
    if not coarse:
        return None

    # Fine search around the coarse tempo: the true period gives the sharpest fold.
    best = (-1.0, coarse)
    for bpm in np.arange(coarse * 0.985, coarse * 1.015, 0.005):
        h = _fold(env, times, 60.0 / bpm)
        sharp = h.max() / (h.mean() + 1e-9)
        if sharp > best[0]:
            best = (sharp, bpm)
    sharp, bpm = best
    if sharp < 4.0:  # no steady beat (rubato, ambient, speech): better no grid than a wrong one
        return None
    period = 60.0 / bpm
    phase = _best_phase(_fold(env, times, period))
    first_beat = (phase * period - ONSET_LAG) % period

    # Downbeat: the beat phase (of 4) where the harmony changes most.
    chroma_bins = (f > 65) & (f < 2000)
    midi = 69 + 12 * np.log2(np.maximum(f[chroma_bins], 1e-9) / 440.0)
    pc = np.mod(np.round(midi).astype(int), 12)
    frame_t = times
    n_beats = int((frame_t[-1] - first_beat) / period)
    if n_beats < 16:
        return None
    S_b = S[chroma_bins][:, 1:]
    chroma = np.zeros((n_beats, 12))
    beat_idx = ((frame_t - first_beat) / period).astype(int)
    ok = (frame_t >= first_beat) & (beat_idx < n_beats)
    for p in range(12):
        rows = S_b[pc == p].sum(axis=0)
        chroma[:, p] = np.bincount(beat_idx[ok], weights=rows[ok], minlength=n_beats)[:n_beats]
    chroma /= np.linalg.norm(chroma, axis=1, keepdims=True) + 1e-9
    change = np.r_[0.0, 1.0 - (chroma[1:] * chroma[:-1]).sum(axis=1)]
    bar_phase = int(np.argmax([change[p::4].mean() for p in range(4)]))
    downbeat = first_beat + bar_phase * period

    return {
        "bpm": round(float(bpm), 3),
        "beat": round(float(first_beat), 4),
        "downbeat": round(float(downbeat), 4),
        "confidence": round(float(sharp), 2),
    }
