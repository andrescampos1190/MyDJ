import os

import pytest

from conftest import needs_ffmpeg
from downloader import DOWNLOAD_DIR


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


@pytest.mark.parametrize("url", ["not a url", "ftp://example.com/a.mp3", "javascript:alert(1)"])
def test_load_rejects_bad_urls(client, url):
    r = client.post("/api/load", json={"url": url})
    assert r.status_code == 400


def test_audio_rejects_bad_and_unknown_ids(client):
    assert client.get("/api/audio/..%2F..%2Fmain.py").status_code == 404
    assert client.get("/api/audio/" + "0" * 32).status_code == 404


def test_order_without_api_key_is_friendly(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/order", json={"tracks": [{"id": "a"}]})
    assert r.status_code == 503
    assert "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_cors_allows_local_frontend(client):
    r = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


@needs_ffmpeg
def test_load_downloads_converts_analyzes_and_streams(client, media_server):
    r = client.post("/api/load", json={"url": f"{media_server}/C_major.mp3"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["title"] == "C_major"
    assert data["camelot"] == "8B"
    assert 1 <= data["energy"] <= 10
    assert data["audioUrl"] == f"/api/audio/{data['id']}"
    assert os.path.isfile(os.path.join(DOWNLOAD_DIR, data["id"] + ".mp3"))

    audio = client.get(data["audioUrl"])
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/mpeg"
    assert len(audio.content) > 100_000


@needs_ffmpeg
def test_load_reports_missing_source(client, media_server):
    r = client.post("/api/load", json={"url": f"{media_server}/nope.mp3"})
    assert r.status_code == 400
    assert "404" in r.json()["detail"]
