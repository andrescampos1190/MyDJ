"""Generate the test tracks and serve them over local HTTP (for the browser e2e test).

    python backend/tests/serve_media.py [port]
"""

import functools
import http.server
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_fixtures import PROGRESSIONS, progression, write_audio  # noqa: E402

port = int(sys.argv[1]) if len(sys.argv) > 1 else 9100
root = tempfile.mkdtemp(prefix="mydj-media-")
for key in PROGRESSIONS:
    write_audio(os.path.join(root, key.replace(" ", "_") + ".mp3"), progression(key))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
print(f"serving {sorted(os.listdir(root))} on http://127.0.0.1:{port}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
