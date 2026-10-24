import functools
import http.server
import os
import shutil
import sys
import tempfile
import threading

import pytest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Must be set before `downloader` is imported: the app wipes this dir on startup,
# so tests never touch a developer's real backend/downloads/.
os.environ["MYDJ_DOWNLOAD_DIR"] = tempfile.mkdtemp(prefix="mydj-test-downloads-")
# Vocal separation takes ~a minute per song: off, except in the tests that turn it on.
os.environ.setdefault("MYDJ_STEMS", "0")

from audio_fixtures import PROGRESSIONS, progression, write_audio  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe not on PATH"
)


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory):
    """One mp3 per key in PROGRESSIONS, e.g. ``A_minor.mp3``."""
    d = tmp_path_factory.mktemp("media")
    for key in PROGRESSIONS:
        write_audio(str(d / (key.replace(" ", "_") + ".mp3")), progression(key))
    return d


@pytest.fixture(scope="session")
def media_server(media_dir):
    """Serve ``media_dir`` over local HTTP; yields the base URL. Lets /api/load run
    its real yt-dlp + ffmpeg path with no internet access."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(media_dir))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from main import app

    with TestClient(app) as c:  # runs the lifespan (download-dir wipe + ffmpeg check)
        yield c
