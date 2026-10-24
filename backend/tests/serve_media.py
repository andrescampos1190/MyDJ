"""Generate the test tracks and serve them over local HTTP (for the browser e2e test).

    python backend/tests/serve_media.py [port]
"""

import functools
import http.server
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_fixtures import (  # noqa: E402
    PROGRESSIONS, groove, loud_song, party_song, progression, structured, write_audio,
)

port = int(sys.argv[1]) if len(sys.argv) > 1 else 9100
root = tempfile.mkdtemp(prefix="mydj-media-")
for key in PROGRESSIONS:
    write_audio(os.path.join(root, key.replace(" ", "_") + ".mp3"), progression(key))
write_audio(os.path.join(root, "party_song.mp3"), party_song())
write_audio(os.path.join(root, "loud.mp3"), loud_song())
write_audio(os.path.join(root, "quiet.mp3"), loud_song() * 10 ** (-5 / 20))  # same song, 5 dB down
# Grooves on exact, known grids (the browser tests check beat-matching against these).
write_audio(os.path.join(root, "groove_122.mp3"), groove(122.0, 0.4, 60, "A minor"))
write_audio(os.path.join(root, "groove_125.mp3"), groove(125.4, 0.9, 60, "C major"))
write_audio(os.path.join(root, "groove_100.mp3"), groove(100.0, 0.2, 60, "G major"))
write_audio(os.path.join(root, "groove_eb.mp3"), groove(124.0, 0.6, 60, "Eb minor"))
# 2-bar quiet intro straight into a 14-bar drop: too short to blend over -> intro loop.
write_audio(os.path.join(root, "intro_song.mp3"),
            structured(124.0, 0.3, "C major", [("quiet", 2), ("loud", 14), ("mid", 14)]))
# EDM-style: intro, drop, break, drop (for double drops).
write_audio(os.path.join(root, "drop_a.mp3"),
            structured(124.0, 0.5, "A minor", [("quiet", 8), ("loud", 16), ("quiet", 8), ("loud", 16)]))
write_audio(os.path.join(root, "drop_b.mp3"),
            structured(125.0, 0.2, "C major", [("quiet", 8), ("loud", 16), ("quiet", 8), ("loud", 16)]))
# Sung all the way through / singing from bar 2 (for vocal swaps).
write_audio(os.path.join(root, "vocal_a.mp3"),
            structured(124.0, 0.5, "A minor", [("loud", 24)], vocals=[(0, 24)]))
write_audio(os.path.join(root, "vocal_b.mp3"),
            structured(124.0, 0.3, "C major", [("loud", 24)], vocals=[(2, 24)]))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
print(f"serving {sorted(os.listdir(root))} on http://127.0.0.1:{port}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
