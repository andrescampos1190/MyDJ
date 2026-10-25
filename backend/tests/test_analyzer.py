import numpy as np
import pytest

from analyzer import analyze
from audio_fixtures import SR, party_song, progression, write_audio
from conftest import needs_ffmpeg

pytestmark = needs_ffmpeg


@pytest.mark.parametrize(
    "key,camelot",
    [("A minor", "8A"), ("C major", "8B"), ("G major", "9B")],
)
def test_detects_key(tmp_path, key, camelot):
    path = write_audio(str(tmp_path / "t.mp3"), progression(key))
    res = analyze(path)
    assert res["key"] == key
    assert res["camelot"] == camelot
    assert 1 <= res["energy"] <= 10


def test_structure_finds_quiet_intro_and_outro(tmp_path):
    groove = progression("A minor", secs=40)
    quiet = 0.02 * progression("A minor", secs=10)
    path = write_audio(str(tmp_path / "t.mp3"), np.concatenate([quiet, groove, quiet]))
    res = analyze(path)
    assert 8 <= res["introEnd"] <= 12
    assert 48 <= res["outroStart"] <= 52
    assert 0 < len(res["energyCurve"]) <= 100


def test_silence_has_no_key(tmp_path):
    path = write_audio(str(tmp_path / "t.mp3"), np.zeros(SR * 5))
    res = analyze(path)
    assert res["key"] is None and res["camelot"] is None


def test_unreadable_file_never_raises(tmp_path):
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"not audio")
    res = analyze(str(bad))
    assert res["key"] is None and res["energy"] is None


def test_big_parts_find_the_choruses(tmp_path):
    res = analyze(write_audio(str(tmp_path / "t.mp3"), party_song()))
    (a0, a1), (b0, b1), (c0, c1) = res["bigParts"]  # choruses at 20-60, 90-130, 160-200 s
    for (s, e), (ts, te) in zip(res["bigParts"], [(20, 60), (90, 130), (160, 200)]):
        assert abs(s - ts) <= 2 and (abs(e - te) <= 2 or te == 200 and e >= 196)
    assert len(res["loudness"]) == 200


def test_lufs_tracks_level(tmp_path):
    y = progression("C major")
    loud = analyze(write_audio(str(tmp_path / "loud.mp3"), y))["lufs"]
    quiet = analyze(write_audio(str(tmp_path / "quiet.mp3"), y * 10 ** (-12 / 20)))["lufs"]
    assert -30 < loud < -5
    assert loud - quiet == pytest.approx(12, abs=0.5)


def test_silence_has_no_loudness(tmp_path):
    res = analyze(write_audio(str(tmp_path / "t.mp3"), np.zeros(SR * 30)))
    assert res["lufs"] is None and res["bigParts"] == []
