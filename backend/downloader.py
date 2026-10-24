"""yt-dlp wrapper: metadata extraction + audio/video download.

Used as a library (``import yt_dlp``) rather than shelling out to the CLI, so we
get structured info dicts and clean exceptions. ffmpeg/ffprobe must be on PATH.
"""

import glob
import os
import re
import uuid

import yt_dlp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Overridable so tests (or a host with a separate scratch disk) can point it elsewhere.
DOWNLOAD_DIR = os.environ.get("MYDJ_DOWNLOAD_DIR") or os.path.join(BASE_DIR, "downloads")

# Resilience for flaky networks: a bounded socket timeout (so a bad connection fails
# fast instead of hanging a worker thread) + internal retries (so a transient DNS/HTTP
# blip self-heals instead of failing the add). Addresses intermittent 'getaddrinfo failed'
# seen after many rapid downloads.
_NET_OPTS = {
    "socket_timeout": 30,
    "retries": 5,
    "fragment_retries": 5,
    "extractor_retries": 3,
}


def _ensure_download_dir() -> None:
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def _first_entry(info: dict) -> dict:
    """If a playlist/multi-entry result slips through, use the first entry."""
    if info.get("_type") == "playlist" and info.get("entries"):
        entries = [e for e in info["entries"] if e]
        if entries:
            return entries[0]
    return info


def _sanitize_filename(name: str | None, fallback: str) -> str:
    """Make a title safe to use as a download filename (cross-platform)."""
    name = (name or "").strip()
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)   # illegal on Windows
    name = re.sub(r"\s+", " ", name).strip()
    return name[:120] or fallback


def get_info(url: str) -> dict:
    """Return preview metadata for ``url`` without downloading.

    Keys: title, duration (seconds | None), thumbnail, uploader.
    """
    opts = {
        **_NET_OPTS,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _first_entry(ydl.extract_info(url, download=False))

    return {
        "title": info.get("title"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "uploader": info.get("uploader"),
    }


def download(url: str, mode: str) -> dict:
    """Download ``url`` as ``"audio"`` (mp3) or ``"video"`` (mp4).

    Returns ``{"path": <abs path on disk>, "filename": <friendly name>}``.
    The on-disk name is a collision-free UUID; ``filename`` is the sanitized
    title for the browser's Save dialog.
    """
    if mode not in ("audio", "video"):
        raise ValueError(f"Invalid mode: {mode!r} (expected 'audio' or 'video')")

    _ensure_download_dir()
    file_id = uuid.uuid4().hex
    outtmpl = os.path.join(DOWNLOAD_DIR, f"{file_id}.%(ext)s")

    opts = {
        **_NET_OPTS,
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    if mode == "audio":
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]
    else:  # video
        opts["format"] = "bestvideo+bestaudio/best"
        opts["merge_output_format"] = "mp4"

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _first_entry(ydl.extract_info(url, download=True))

    # The final file is the lone survivor matching our UUID prefix: yt-dlp deletes
    # the pre-conversion audio / pre-merge streams. Globbing is robust whether the
    # result is .mp3, .mp4, or (rarely) some other container.
    matches = glob.glob(os.path.join(DOWNLOAD_DIR, file_id + ".*"))
    if not matches:
        raise RuntimeError("Download finished but no output file was found")
    final_path = max(matches, key=os.path.getsize)

    ext = os.path.splitext(final_path)[1].lstrip(".").lower() or (
        "mp3" if mode == "audio" else "mp4"
    )
    # If audio conversion failed (e.g. ffmpeg missing) we'd be left with a raw
    # .webm/.m4a that the /api/audio route (which serves {id}.mp3) can't deliver.
    # Treat that as a hard error and clean up the partials instead of half-succeeding.
    if mode == "audio" and ext != "mp3":
        for m in matches:
            try:
                os.remove(m)
            except OSError:
                pass
        raise RuntimeError("Audio conversion failed — is ffmpeg on PATH?")
    friendly = f"{_sanitize_filename(info.get('title'), file_id)}.{ext}"
    return {
        "id": file_id,
        "path": final_path,
        "filename": friendly,
        "title": info.get("title"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "uploader": info.get("uploader"),
    }
