"""Generate the test tracks and serve them over local HTTP (for the browser e2e test).

    python backend/tests/serve_media.py [port]
"""

import functools
import http.server
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_fixtures import PROGRESSIONS, groove, loud_song, party_song, progression, write_audio  # noqa: E402

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

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
print(f"serving {sorted(os.listdir(root))} on http://127.0.0.1:{port}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
