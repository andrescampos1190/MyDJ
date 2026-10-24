"""Real downloads from YouTube / SoundCloud. Needs open internet, so these only run
with MYDJ_LIVE=1 (CI's live job sets it). Sites change and block datacenter IPs, so a
failure here can be the site rather than the code; the error detail says which."""

import os

import pytest

from conftest import needs_ffmpeg

pytestmark = [
    needs_ffmpeg,
    pytest.mark.skipif(os.environ.get("MYDJ_LIVE") != "1", reason="set MYDJ_LIVE=1 to run"),
]


def test_yt_dlp_has_a_js_runtime():
    # YouTube extraction needs one; without it formats go missing and loads fail.
    from yt_dlp import YoutubeDL

    runtimes = YoutubeDL({"quiet": True})._js_runtimes
    assert any(rt and rt.info and rt.info.supported for rt in runtimes.values()), runtimes


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=jNQXAC9IVRw",  # "Me at the zoo", 19 s
        "https://soundcloud.com/forss/flickermood",
    ],
    ids=["youtube", "soundcloud"],
)
def test_live_load(client, url):
    r = client.post("/api/load", json={"url": url})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["title"]
    assert client.get(data["audioUrl"]).status_code == 200


def test_live_search(client):
    r = client.get("/api/search", params={"q": "me at the zoo"})
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert results and all(x["url"].startswith("https://") for x in results)
