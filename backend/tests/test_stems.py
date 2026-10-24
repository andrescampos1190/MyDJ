import os
import time

import numpy as np
import pytest

import stems
from audio_fixtures import SR, groove, voice, write_audio
from conftest import needs_ffmpeg

pytestmark = needs_ffmpeg


@pytest.fixture(scope="module")
def model():
    """The separation model (downloads ~65 MB once). CI sets MYDJ_REQUIRE_STEMS=1 so a
    missing model fails instead of silently skipping."""
    try:
        import onnxruntime  # noqa: F401

        return stems.model_path()
    except Exception as exc:
        if os.environ.get("MYDJ_REQUIRE_STEMS") == "1":
            raise
        pytest.skip(f"separation model unavailable: {exc}")


@pytest.fixture(scope="module")
def singer(tmp_path_factory):
    """A 40 s groove with a singer at 10-20 s and 28-36 s."""
    g = groove(124.0, 0.5, 40, "A minor")
    t = np.arange(g.size) / SR
    sing = ((t >= 10) & (t < 20)) | ((t >= 28) & (t < 36))
    return write_audio(str(tmp_path_factory.mktemp("stems") / "singer.mp3"), g + 0.5 * voice(40, 124) * sing)


def test_separation_finds_the_vocals_and_the_stems_add_up_to_the_song(model, singer):
    res = stems.separate(singer)
    assert len(res["vocals"]) == 2
    for (a, b), (ta, tb) in zip(res["vocals"], [(10, 20), (28, 36)]):
        assert abs(a - ta) <= 0.5 and abs(b - tb) <= 0.5

    paths = stems.stem_paths(singer)
    mix, voc, inst = (stems._decode(p) for p in (singer, paths["vocals"], paths["inst"]))
    n = min(mix.shape[1], voc.shape[1], inst.shape[1])
    err = mix[:, :n] - (voc[:, :n] + inst[:, :n])
    db = lambda x: 10 * np.log10((x ** 2).mean() + 1e-12)
    assert db(err) - db(mix[:, :n]) < -25  # played together, the stems are the song
    # The beat stays in the instrumental: the vocal stem is near-silent between lines.
    gap = slice(22 * SR, 26 * SR)
    assert db(voc[:, gap]) - db(mix[:, gap]) < -25


def test_vocal_segments_merge_breaths_and_drop_blips():
    frame = int(SR * 0.25)
    mix = np.full((2, 40 * 4 * frame), 0.3, np.float32)
    voc = np.zeros_like(mix)
    for a, b in [(4, 8), (8.75, 12), (20, 20.25)]:  # a line, a breath, another, a blip
        voc[:, int(a * SR): int(b * SR)] = 0.3
    assert stems.vocal_segments(voc, mix) == [[4.0, 12.0]]


def test_pending_songs_run_in_playlist_order():
    jobs = stems.StemJobs()
    jobs.order = ["a", "b", "c", "d"]
    jobs.prioritize(["c", "a"])
    assert jobs.order == ["c", "a", "b", "d"]


def _wait(client, tid, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        st = client.get(f"/api/stems?ids={tid}").json()[tid]
        if st["status"] not in ("queued", "running"):
            return st
        time.sleep(1)
    raise AssertionError("separation didn't finish")


def test_loaded_tracks_are_separated_in_the_background(model, client, media_server, monkeypatch):
    import main

    monkeypatch.setenv("MYDJ_STEMS", "1")
    monkeypatch.setenv("MYDJ_MODEL_DIR", os.path.dirname(model))
    monkeypatch.setattr(main, "stem_jobs", stems.StemJobs())
    r = client.post("/api/load", json={"url": f"{media_server}/A_minor.mp3"}).json()
    assert r["stems"] == "queued"
    st = _wait(client, r["id"])
    assert st["status"] == "done" and st["vocals"] == []  # an instrumental: no vocals
    for part in ("vocals", "inst"):
        res = client.get(f"/api/stems/{r['id']}/{part}")
        assert res.status_code == 200 and res.headers["content-type"] == "audio/mpeg"
    assert client.get(f"/api/stems/{r['id']}/inst?semitones=1").status_code == 200
    assert client.get(f"/api/stems/{r['id']}/drums").status_code == 404


def test_no_model_means_stems_are_unavailable_not_broken(client, media_server, monkeypatch, tmp_path):
    import main

    pytest.importorskip("onnxruntime")
    monkeypatch.setenv("MYDJ_STEMS", "1")
    monkeypatch.setenv("MYDJ_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("MYDJ_MODEL_URL", "http://127.0.0.1:9/missing.onnx")
    monkeypatch.setattr(main, "stem_jobs", stems.StemJobs())
    tid = client.post("/api/load", json={"url": f"{media_server}/C_major.mp3"}).json()["id"]
    assert _wait(client, tid, 60)["status"] == "unavailable"
    # ...and later songs aren't even queued; the mixer falls back to genre-based choices.
    assert client.post("/api/load", json={"url": f"{media_server}/G_major.mp3"}).json()["stems"] == "off"


def test_stems_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("MYDJ_STEMS", "0")
    assert stems.StemJobs().add("0" * 32, "x.mp3") == "off"
