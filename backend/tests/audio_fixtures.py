"""Synthesized test music with a known key, so analysis can be checked offline."""

import subprocess

import numpy as np

SR = 44100

# Pitches (Hz) used to build the chord progressions below.
G3, A3, B3 = 196.0, 220.0, 246.94
C4, D4, E4, F4, FS4, G4 = 261.63, 293.66, 329.63, 349.23, 369.99, 392.0

# i/I - iv/IV - v/V - i/I progressions: enough harmonic context that the key is
# unambiguous (a lone triad can read as its relative major/minor).
PROGRESSIONS = {
    "A minor": [(A3, C4, E4), (D4, F4, 2 * A3), (E4, G4, 2 * B3), (A3, C4, E4)],
    "C major": [(C4, E4, G4), (F4, 2 * A3, 2 * C4), (G3, B3, D4), (C4, E4, G4)],
    "G major": [(G3, B3, D4), (C4, E4, G4), (D4, FS4, 2 * A3), (G3, B3, D4)],
}


def _tone(freq: float, t: np.ndarray) -> np.ndarray:
    return sum(np.sin(2 * np.pi * freq * h * t) / h for h in (1, 2, 3))


def progression(key: str, secs: float = 24.0, bpm: float = 124.0) -> np.ndarray:
    """Chords for ``key`` over a four-on-the-floor kick at ``bpm``."""
    chords = PROGRESSIONS[key]
    t = np.arange(int(secs * SR)) / SR
    y = np.zeros_like(t)
    seg = len(t) // len(chords)
    for i, chord in enumerate(chords):
        s = slice(i * seg, (i + 1) * seg)
        y[s] = sum(_tone(f, t[s]) for f in chord) / len(chord) * 0.3
    phase = np.mod(t, 60.0 / bpm)
    y += 0.6 * np.sin(2 * np.pi * 55 * phase) * np.exp(-phase * 25)
    return y


def write_audio(path: str, y: np.ndarray) -> str:
    """Encode mono float samples to ``path`` (format from the extension) via ffmpeg."""
    pcm = (np.clip(y, -1, 1) * 32767).astype("<i2").tobytes()
    subprocess.run(
        ["ffmpeg", "-v", "quiet", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", path],
        input=pcm,
        check=True,
    )
    return path


def party_song() -> np.ndarray:
    """120 s song shaped verse / big chorus (20-75 s) / verse / final chorus (90-120 s).
    Played to the end it would mix out ~16 s before the end; party mode should leave
    over the tail of the first chorus (~67 s)."""
    y = progression("A minor", secs=120)
    t = np.arange(len(y)) / SR
    loud = ((t >= 20) & (t < 75)) | (t >= 90)
    return y * np.where(loud, 1.0, 0.15)
