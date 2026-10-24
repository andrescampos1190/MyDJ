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
    # Eb minor (Camelot 2A): clashes with A minor (8A), a semitone from D/E minor.
    "Eb minor": [(311.13, 369.99, 466.16), (207.65, 246.94, 311.13), (233.08, 277.18, 349.23),
                 (311.13, 369.99, 466.16)],
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


def loud_song() -> np.ndarray:
    """A dense, loudly mastered track (~-10 LUFS) for volume-matching tests."""
    return np.tanh(3 * progression("C major")) * 0.9


def groove(bpm: float, first_beat: float = 0.0, secs: float = 60.0, key: str = "A minor") -> np.ndarray:
    """A produced-style 4/4 groove on an exact grid: kick on every beat, snare on 2 and 4,
    off-beat hats, and the key's chords changing on each downbeat (the first beat at
    `first_beat` is a downbeat)."""
    t = np.arange(int(secs * SR)) / SR
    beat = 60.0 / bpm
    rel = t - first_beat
    y = np.zeros_like(t)
    on = rel >= 0
    ph = np.mod(rel, beat)
    y += on * 0.7 * np.sin(2 * np.pi * 55 * ph) * np.exp(-ph * 30)  # kick
    beat_n = np.floor(rel / beat).astype(int)
    snare = on & (np.mod(beat_n, 2) == 1)
    rng = np.random.default_rng(0)
    noise = rng.uniform(-1, 1, t.size)
    y += snare * 0.25 * noise * np.exp(-ph * 40)
    hat_ph = np.mod(rel - beat / 2, beat)
    y += on * 0.08 * noise * np.exp(-hat_ph * 120)
    chords = PROGRESSIONS[key]
    bar_n = np.floor(rel / (4 * beat)).astype(int)
    pad = np.zeros_like(t)
    for i, chord in enumerate(chords):
        m = on & (np.mod(bar_n, len(chords)) == i)
        pad[m] = sum(_tone(f, t[m]) for f in chord) / len(chord)
    return y + 0.25 * pad


def voice(secs: float, bpm: float, seed: int = 5) -> np.ndarray:
    """A synthetic singer: a quarter-note melody (A minor scale) with glides and vibrato,
    a glottal-pulse-like source shaped by moving vowel formants, syllables every 8th."""
    from scipy.signal import lfilter

    vowels = [(730, 1090, 2440), (270, 2290, 3010), (300, 870, 2240), (530, 1840, 2480), (570, 840, 2410)]
    rng = np.random.default_rng(seed)
    n = int(secs * SR)
    t = np.arange(n) / SR
    beat = 60.0 / bpm
    scale = [0, 2, 3, 5, 7, 8, 10]
    notes = np.array(scale, float)[rng.integers(0, len(scale), int(n / (beat * SR)) + 2)]
    k = int(0.06 * SR)
    glide = np.convolve(notes[(t / beat).astype(int)], np.ones(k) / k, mode="same")  # portamento
    f0 = 220 * 2 ** ((glide + 0.4 * np.sin(2 * np.pi * 5.5 * t)) / 12)
    env = 0.5 + 0.5 * np.clip(np.sin(np.pi * np.mod(t, beat / 2) / (beat / 2)), 0, 1)
    phase = 2 * np.pi * np.cumsum(f0) / SR
    src = (sum(np.sin(h * phase) / h for h in range(1, 30)) + 0.05 * rng.normal(0, 1, n)) * env
    out = np.zeros_like(src)
    seg = SR // 8
    pick = rng.integers(0, len(vowels), n // seg + 1)
    for j, s in enumerate(range(0, n, seg)):
        chunk = src[s: s + seg]
        for fc, bw in zip(vowels[pick[j]], (80, 120, 160)):
            r = np.exp(-np.pi * bw / SR)
            out[s: s + seg] += lfilter([1 - r], [1, -2 * r * np.cos(2 * np.pi * fc / SR), r * r], chunk)
    return out / (np.abs(out).max() + 1e-9)


def structured(bpm: float, first_beat: float, key: str, sections, vocals=()) -> np.ndarray:
    """A groove arranged in sections, e.g. [("quiet", 8), ("loud", 16), ...] (bars):
    quiet = intro / break level, loud = drop / chorus, mid = verse. `vocals`: bar ranges
    [(from, to), ...] with a singer on top."""
    level = {"quiet": 0.12, "mid": 0.45, "loud": 1.0}
    bar = 4 * 60.0 / bpm
    secs = first_beat + sum(n for _, n in sections) * bar
    y = groove(bpm, first_beat, secs, key)
    t = np.arange(y.size) / SR
    gain = np.full(y.size, level[sections[0][0]])
    at = first_beat
    for name, n in sections:
        gain[(t >= at) & (t < at + n * bar)] = level[name]
        at += n * bar
    y = y * gain
    if vocals:
        sing = np.zeros(y.size, bool)
        for a, b in vocals:
            sing |= (t >= first_beat + a * bar) & (t < first_beat + b * bar)
        y = y + 0.5 * voice(secs, bpm) * sing
    return y
