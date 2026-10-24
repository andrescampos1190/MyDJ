"""YTDLP_COOKIES_FILE: cookies must actually reach the source (the YouTube bot-check
workaround on cloud hosts), and a bot-check refusal must come back as a clear message."""

import functools
import http.server
import os
import threading

import pytest
from yt_dlp.utils import DownloadError

import downloader
import main
from conftest import needs_ffmpeg


class _CookieGate(http.server.SimpleHTTPRequestHandler):
    """Serves files only to requests carrying the cookie ``mydj=ok``."""

    def do_GET(self):
        if "mydj=ok" not in (self.headers.get("Cookie") or ""):
            self.send_error(403, "cookie required")
            return
        super().do_GET()

    def log_message(self, *a):
        pass


@pytest.fixture
def gated_server(media_dir):
    srv = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(_CookieGate, directory=str(media_dir))
    )
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture
def cookie_env(tmp_path, monkeypatch):
    def use(lines):
        f = tmp_path / "cookies.txt"
        f.write_text("# Netscape HTTP Cookie File\n" + "".join(l + "\n" for l in lines))
        f.chmod(0o444)  # like a read-only secret mount
        monkeypatch.setenv("YTDLP_COOKIES_FILE", str(f))
        monkeypatch.setattr(downloader, "_cookie_copy", None)
        return f

    return use


@needs_ffmpeg
def test_cookies_reach_the_source(client, gated_server, cookie_env):
    url = f"{gated_server}/A_minor.mp3"
    assert client.post("/api/load", json={"url": url}).status_code == 400  # no cookie yet

    cookie_env(["127.0.0.1\tFALSE\t/\tFALSE\t2147483647\tmydj\tok"])
    r = client.post("/api/load", json={"url": url})
    assert r.status_code == 200, r.text
    assert r.json()["camelot"] == "8A"


def test_cookie_file_is_used_via_a_writable_copy(cookie_env):
    src = cookie_env(["127.0.0.1\tFALSE\t/\tFALSE\t2147483647\tmydj\tok"])
    opts = downloader._cookie_opts()
    copy = opts["cookiefile"]
    assert copy != str(src) and os.access(copy, os.W_OK)
    assert open(copy).read() == src.read_text()
    assert downloader._cookie_opts() == opts  # reused, so refreshed cookies persist


def test_missing_cookie_file_is_ignored(monkeypatch):
    monkeypatch.setenv("YTDLP_COOKIES_FILE", "/nonexistent/cookies.txt")
    assert downloader._cookie_opts() == {}
    monkeypatch.delenv("YTDLP_COOKIES_FILE")
    assert downloader._cookie_opts() == {}


def test_bot_check_gets_an_actionable_message(client, monkeypatch):
    def blocked(url, mode):
        raise DownloadError(
            "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. "
            "Use --cookies-from-browser or --cookies for the authentication."
        )

    monkeypatch.setattr(main, "download", blocked)
    r = client.post("/api/load", json={"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"})
    assert r.status_code == 400
    assert "YTDLP_COOKIES_FILE" in r.json()["detail"]
