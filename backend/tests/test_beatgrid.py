import numpy as np
import pytest

from analyzer import SR, _decode, analyze
from audio_fixtures import groove, write_audio
from beatgrid import beat_grid
from conftest import needs_ffmpeg

pytestmark = needs_ffmpeg


def _phase_err_ms(t, true_t, period):
    return abs(((t - true_t + period / 2) % period) - period / 2) * 1000


@pytest.mark.parametrize(
    "bpm,first,key",
    [(123.6, 0.37, "A minor"), (95.3, 1.1, "C major"), (128.0, 0.05, "G major"),
     (140.25, 0.6, "A minor"), (88.0, 2.0, "C major")],
)
def test_grid_is_precise_enough_to_beatmatch(tmp_path, bpm, first, key):
    y = _decode(write_audio(str(tmp_path / "g.mp3"), groove(bpm, first, 150, key)))
    g = beat_grid(y, SR)
    assert g is not None
    # 0.02 BPM off drifts < 3 ms over a 30 s blend.
    assert g["bpm"] == pytest.approx(bpm, abs=0.02)
    period = 60 / bpm
    assert _phase_err_ms(g["beat"], first, period) < 5
    # The downbeat lands on the "1" of the bar, not just any beat.
    assert _phase_err_ms(g["downbeat"], first, 4 * period) < 5


def test_no_grid_without_a_steady_beat(tmp_path):
    noise = np.random.default_rng(1).uniform(-0.3, 0.3, SR * 60)
    y = _decode(write_audio(str(tmp_path / "n.mp3"), noise))
    assert beat_grid(y, SR) is None


def test_analyze_returns_the_grid(tmp_path):
    res = analyze(write_audio(str(tmp_path / "g.mp3"), groove(126.0, 0.5, 90)))
    assert res["grid"]["bpm"] == pytest.approx(126.0, abs=0.02)
