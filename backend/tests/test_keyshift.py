import os

import pytest

import keyshift
from analyzer import analyze
from audio_fixtures import groove, write_audio
from conftest import needs_ffmpeg

pytestmark = needs_ffmpeg


@pytest.fixture
def am_groove(tmp_path):
    return write_audio(str(tmp_path / "g.mp3"), groove(124.0, 0.4, 60, "A minor"))


@pytest.mark.parametrize("rubberband", [True, False], ids=["rubberband", "fallback"])
@pytest.mark.parametrize("semis,key,camelot", [(1, "Bb minor", "3A"), (-1, "Ab minor", "1A")])
def test_key_shift_moves_the_key_and_keeps_the_tempo(am_groove, monkeypatch, rubberband, semis, key, camelot):
    if rubberband and not keyshift.has_rubberband():
        pytest.skip("this ffmpeg has no rubberband")
    monkeypatch.setattr(keyshift, "has_rubberband", lambda: rubberband)
    before = analyze(am_groove)
    assert before["camelot"] == "8A"
    out = keyshift.shifted(am_groove, semis)
    after = analyze(out)
    assert (after["key"], after["camelot"]) == (key, camelot)
    assert after["grid"]["bpm"] == pytest.approx(before["grid"]["bpm"], abs=0.05)  # same tempo


def test_shifted_copy_is_cached(am_groove):
    a = keyshift.shifted(am_groove, 1)
    mtime = os.path.getmtime(a)
    assert keyshift.shifted(am_groove, 1) == a and os.path.getmtime(a) == mtime


def test_audio_endpoint_serves_key_shifted_copies(client, media_server):
    tid = client.post("/api/load", json={"url": f"{media_server}/A_minor.mp3"}).json()["id"]
    plain = client.get(f"/api/audio/{tid}")
    up = client.get(f"/api/audio/{tid}", params={"semitones": 1})
    assert up.status_code == 200 and up.headers["content-type"] == "audio/mpeg"
    assert up.content != plain.content
    assert client.get(f"/api/audio/{tid}", params={"semitones": 5}).status_code == 400
