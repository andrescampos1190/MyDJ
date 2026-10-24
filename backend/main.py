"""FastAPI backend for MyDJ.

Fetches audio with yt-dlp and serves it to the browser's Web Audio engine for
in-app DJ mixing. Nothing is saved to the user's computer: the browser holds the
audio in memory while mixing, and the server's temp copies are wiped each session.

Local/personal use only: no auth.
"""

import glob
import os
import re
import shutil
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from starlette.background import BackgroundTask
from yt_dlp.utils import DownloadError, ExtractorError

from analyzer import analyze
from downloader import DOWNLOAD_DIR, download, get_info
from llm_order import order_tracks

# Load backend/.env (e.g. ANTHROPIC_API_KEY for AI Polish) regardless of CWD.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _wipe_downloads() -> None:
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    for f in glob.glob(os.path.join(DOWNLOAD_DIR, "*")):
        try:
            os.remove(f)
        except OSError:
            pass


# Keep the temp dir bounded over a long session (each load/reload writes a fresh
# UUID mp3). 200 >> a 6-hour set (~90 tracks), so nothing in an active playlist is
# ever pruned — this only reclaims space from repeated re-adds of the same URLs.
MAX_CACHED = 200


def _prune_downloads(keep: int = MAX_CACHED) -> None:
    try:
        files = glob.glob(os.path.join(DOWNLOAD_DIR, "*.mp3"))
        if len(files) <= keep:
            return
        files.sort(key=os.path.getmtime, reverse=True)  # newest first
        for f in files[keep:]:
            try:
                os.remove(f)
            except OSError:
                pass
    except OSError:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    _wipe_downloads()  # start each session with a clean temp dir
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print(
            "WARNING: ffmpeg/ffprobe not found on PATH — track loading will fail. "
            "Install ffmpeg (e.g. `winget install Gyan.FFmpeg`) and restart the backend."
        )
    yield


app = FastAPI(title="MyDJ", lifespan=lifespan)

# Frontend origins allowed to call the API. Defaults to local dev; in production set
# ALLOWED_ORIGINS (comma-separated), e.g. "https://your-frontend.onrender.com".
_DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


class UrlRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    mode: str


class OrderRequest(BaseModel):
    tracks: list[dict]


def _validate_url(url: str) -> None:
    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="URL must be a valid http(s) link")


def _clean_error(exc: Exception) -> str:
    msg = str(exc)
    for noise in ("\x1b[0;31m", "\x1b[0m"):
        msg = msg.replace(noise, "")
    if msg.upper().startswith("ERROR:"):
        msg = msg[6:].strip()
    return msg[:300] or "Unsupported or unreachable URL"


def _is_bot_check(msg: str) -> bool:
    """YouTube refusing an anonymous request (typical from cloud/datacenter IPs)."""
    m = msg.lower()
    return "confirm you" in m and "not a bot" in m


BOT_CHECK_DETAIL = (
    "YouTube is blocking this server as a bot (common on cloud hosts). Give the backend "
    "YouTube cookies via YTDLP_COOKIES_FILE — see the README."
)


def _is_network_err(msg: str) -> bool:
    """Transient connectivity failures (DNS/socket) — retryable, not a bad URL."""
    m = msg.lower()
    return any(
        s in m
        for s in (
            "getaddrinfo", "failed to resolve", "name resolution", "connection reset",
            "network is unreachable", "temporary failure", "connection timed out",
            "read timed out", "max retries",
        )
    )


def _cleanup(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/info")
def info(req: UrlRequest):
    _validate_url(req.url)
    try:
        return get_info(req.url)
    except (DownloadError, ExtractorError) as exc:
        msg = _clean_error(exc)
        raise HTTPException(status_code=400, detail=BOT_CHECK_DETAIL if _is_bot_check(msg) else msg)
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to fetch info for this URL")


@app.post("/api/load")
def load(req: UrlRequest):
    """Download + convert a track server-side; return its metadata and an audio
    URL the browser streams into Web Audio. The file lives on the server only for
    the session (wiped on startup) and never lands in the user's downloads.
    """
    _validate_url(req.url)
    try:
        res = download(req.url, "audio")
    except (DownloadError, ExtractorError) as exc:
        msg = _clean_error(exc)
        if _is_network_err(msg):
            raise HTTPException(
                status_code=503,
                detail="Network/DNS hiccup reaching the source — please retry.",
            )
        if _is_bot_check(msg):
            raise HTTPException(status_code=400, detail=BOT_CHECK_DETAIL)
        raise HTTPException(status_code=400, detail=msg)
    except Exception:
        if not shutil.which("ffmpeg"):
            raise HTTPException(
                status_code=500,
                detail="ffmpeg not found on PATH — install it and restart the backend.",
            )
        raise HTTPException(status_code=500, detail="Failed to load this track")
    _prune_downloads()  # keep the temp dir bounded across a long session
    feat = analyze(res["path"])  # {key, camelot, energy} — best-effort, never raises
    return {
        "id": res["id"],
        "title": res["title"],
        "duration": res["duration"],
        "thumbnail": res["thumbnail"],
        "uploader": res["uploader"],
        "audioUrl": f"/api/audio/{res['id']}",
        "key": feat["key"],
        "camelot": feat["camelot"],
        "energy": feat["energy"],
        "introEnd": feat["introEnd"],
        "outroStart": feat["outroStart"],
        "energyCurve": feat["energyCurve"],
    }


@app.get("/api/audio/{track_id}")
def audio(track_id: str):
    """Serve a loaded track inline for the browser to decode into an AudioBuffer."""
    if not ID_RE.match(track_id):
        raise HTTPException(status_code=404, detail="Not found")
    path = os.path.join(DOWNLOAD_DIR, f"{track_id}.mp3")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Track not loaded (reload it)")
    return FileResponse(path, media_type="audio/mpeg")


@app.post("/api/order")
def order(req: OrderRequest):
    """Optional 'AI Polish': sequence the playlist with Claude (needs ANTHROPIC_API_KEY)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="Set ANTHROPIC_API_KEY in the backend environment to use AI Polish.",
        )
    try:
        ordered = order_tracks(req.tracks)  # [{id, genre}]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI ordering failed: {exc}")
    if not ordered:
        raise HTTPException(status_code=502, detail="AI returned no usable order")
    return {"order": ordered}


@app.post("/api/download")
def download_endpoint(req: DownloadRequest):
    """Optional: save a copy to the user's computer (audio mp3 / video mp4)."""
    _validate_url(req.url)
    if req.mode not in ("audio", "video"):
        raise HTTPException(status_code=400, detail="mode must be 'audio' or 'video'")
    try:
        result = download(req.url, req.mode)
    except (DownloadError, ExtractorError) as exc:
        raise HTTPException(status_code=400, detail=_clean_error(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        raise HTTPException(status_code=500, detail="Download or conversion failed")
    return FileResponse(
        result["path"],
        media_type="application/octet-stream",
        filename=result["filename"],
        background=BackgroundTask(_cleanup, result["path"]),
    )
