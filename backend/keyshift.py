"""Key shifting: a copy of a track moved up or down a semitone or two, same tempo.

DJs fix a key clash by shifting one track's key ("key shift" on modern players).
Rubber Band (ffmpeg's `rubberband` filter) does this at studio quality and, with
formant preservation, keeps voices sounding natural rather than chipmunked. ffmpeg
builds without it fall back to resample-then-time-stretch (asetrate + atempo).
"""

import functools
import os
import subprocess
import uuid


@functools.lru_cache(maxsize=1)
def has_rubberband() -> bool:
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True)
        return " rubberband " in out.stdout
    except OSError:
        return False


def _sample_rate(path: str) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    )
    try:
        return int(out.stdout.strip())
    except ValueError:
        return 44100


def shifted(path: str, semitones: int) -> str:
    """Path of `path` shifted by `semitones` (rendered once, then cached beside it)."""
    out = f"{path[:-4]}.st{semitones:+d}.mp3"
    if os.path.isfile(out):
        return out
    ratio = 2 ** (semitones / 12)
    if has_rubberband():
        af = f"rubberband=pitch={ratio:.8f}:formant=preserved:pitchq=quality"
    else:
        sr = _sample_rate(path)
        af = f"asetrate={sr * ratio:.3f},aresample={sr},atempo={1 / ratio:.8f}"
    tmp = f"{out}.{uuid.uuid4().hex}.tmp.mp3"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path, "-af", af, "-b:a", "192k", tmp],
        check=True, capture_output=True,
    )
    os.replace(tmp, out)  # atomic: concurrent requests never see a half-written file
    return out
