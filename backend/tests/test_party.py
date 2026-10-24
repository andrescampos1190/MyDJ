import time

import main
import party as party_mod
from conftest import needs_ffmpeg
from party import Party

ID = "a" * 32


def test_votes_tally_and_can_be_taken_back():
    p = Party()
    p.vote(ID, "ana", 1)
    p.vote(ID, "ben", 1)
    p.vote(ID, "cy", -1)
    assert p.sync({})["scores"] == {ID: 1}
    p.vote(ID, "ana", -1)  # change of heart
    p.vote(ID, "ben", 0)  # take it back
    assert p.sync({})["scores"] == {ID: -2}


def test_request_lifecycle_is_visible_and_handed_to_the_host_once():
    p = Party()
    rid = p.start_request("Song", "Ana", "ana")
    (pend,) = p.view("ana")["pending"]
    assert pend | {} == {"rid": rid, "title": "Song", "addedBy": "Ana", "status": "downloading",
                         "error": None, "mine": True}
    assert p.view("ben")["pending"][0]["mine"] is False  # others see it coming too
    assert p.sync({})["working"] == 1

    p.finish_request(rid, {"id": ID, "title": "Song (Official Video)"})
    assert p.view("ana")["pending"][0]["status"] == "ready"  # waiting for the DJ's app
    (track,) = p.sync({})["requests"]
    assert track["id"] == ID and track["addedBy"] == "Ana"
    assert p.sync({})["requests"] == []
    assert p.view("ana")["pending"] == []


def test_failed_requests_show_only_to_their_owner_then_expire(monkeypatch):
    p = Party()
    rid = p.start_request(None, "Ana", "ana")
    p.fail_request(rid, "Video unavailable")
    (pend,) = p.view("ana")["pending"]
    assert pend["status"] == "failed" and pend["error"] == "Video unavailable"
    assert p.view("ben")["pending"] == []
    later = time.time() + party_mod.FAILED_TTL + 1
    monkeypatch.setattr(party_mod.time, "time", lambda: later)
    assert p.view("ana")["pending"] == []


def test_connected_phones_are_tracked(monkeypatch):
    p = Party()
    p.view("ana", "Ana")
    p.view("ben", "Ben")
    p.view("", "nobody")  # no voter id: not counted
    assert p.sync({})["guests"] == ["Ana", "Ben"]
    assert p.view("ana", "Ana")["guests"] == ["Ana", "Ben"]
    later = time.time() + party_mod.GUEST_TIMEOUT + 1
    monkeypatch.setattr(party_mod.time, "time", lambda: later)
    assert p.sync({})["guests"] == []


def test_host_presence_is_reported_to_phones(monkeypatch):
    p = Party()
    v = p.view("ana")
    assert v["hostOnline"] is False and v["hostSeenAgo"] is None
    p.sync({})
    assert p.view("ana")["hostOnline"] is True
    later = time.time() + party_mod.HOST_TIMEOUT + 5
    monkeypatch.setattr(party_mod.time, "time", lambda: later)
    v = p.view("ana")
    assert v["hostOnline"] is False and v["hostSeenAgo"] >= party_mod.HOST_TIMEOUT


def test_guest_view_merges_votes_into_the_hosts_queue():
    p = Party()
    assert p.view("ana")["hostOnline"] is False
    p.vote(ID, "ana", 1)
    p.vote(ID, "ben", 1)
    p.sync({"playing": True, "now": {"id": "b" * 32, "title": "Now"}, "next": None,
            "upcoming": [{"id": ID, "title": "Later"}]})
    v = p.view("ana")
    assert v["hostOnline"] and v["playing"]
    assert v["now"]["title"] == "Now" and v["now"]["score"] == 0
    assert v["upcoming"][0] | {} == {"id": ID, "title": "Later", "score": 2, "myVote": 1}
    assert p.view("cy")["upcoming"][0]["myVote"] == 0


def test_vote_endpoint_validates(client):
    assert client.post("/api/party/vote", json={"trackId": "x", "voter": "a", "value": 1}).status_code == 400
    assert client.post("/api/party/vote", json={"trackId": ID, "voter": "", "value": 1}).status_code == 400
    assert client.post("/api/party/vote", json={"trackId": ID, "voter": "a", "value": 1}).status_code == 200


def test_cors_allows_phones_on_the_home_network(client):
    for origin in ("http://192.168.1.23:5173", "http://10.0.0.5:5173", "http://172.20.1.2:5173"):
        r = client.get("/api/health", headers={"Origin": origin})
        assert r.headers.get("access-control-allow-origin") == origin
    r = client.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in r.headers


def test_search_returns_results(client, monkeypatch):
    fake = [{"title": "Song", "url": "https://www.youtube.com/watch?v=abc", "duration": 200,
             "channel": "Artist", "thumbnail": None}]
    monkeypatch.setattr(main, "search", lambda q: fake if q == "song name" else [])
    assert client.get("/api/search", params={"q": " song name "}).json() == {"results": fake}
    assert client.get("/api/search", params={"q": "  "}).status_code == 400


def test_info_lists_lan_addresses(client):
    addrs = client.get("/api/party/info").json()["addresses"]
    assert all(not a.startswith(("127.", "169.254.")) for a in addrs)


def test_default_route_address_comes_first(monkeypatch):
    # Windows often has virtual adapters (WSL/Hyper-V 172.x) that sort before the Wi-Fi.
    class FakeSocket:
        def __init__(self, *a):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

        def connect(self, addr):
            pass

        def getsockname(self):
            return ("192.168.1.23", 5555)

    monkeypatch.setattr(party_mod.socket, "socket", FakeSocket)
    monkeypatch.setattr(party_mod.socket, "getaddrinfo", lambda *a: [
        (0, 0, 0, "", (ip, 0)) for ip in ("172.22.0.1", "192.168.1.23", "127.0.0.1", "169.254.3.4")
    ])
    assert party_mod.lan_addresses() == ["192.168.1.23", "172.22.0.1"]


def _wait_for(pred, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if (v := pred()):
            return v
        time.sleep(0.2)
    raise AssertionError("timed out")


@needs_ffmpeg
def test_guest_request_reaches_the_host(client, media_server, monkeypatch):
    monkeypatch.setattr(main, "party", Party())  # fresh session
    r = client.post("/api/party/request", json={"url": f"{media_server}/A_minor.mp3",
                                                "name": " Ana ", "voter": "ana", "title": "Am"})
    assert r.status_code == 200, r.text  # answers at once; the download runs in the background
    queue = client.get("/api/party/queue", params={"voter": "ana", "name": "Ana"}).json()
    assert queue["pending"][0]["title"] == "Am" and queue["guests"] == ["Ana"]

    def ready():
        return client.post("/api/party/sync", json={"snapshot": {}}).json()["requests"]

    (track,) = _wait_for(ready)
    assert track["addedBy"] == "Ana" and track["camelot"] == "8A" and track["url"].endswith("A_minor.mp3")
    assert track["audioUrl"] == f"/api/audio/{track['id']}"


@needs_ffmpeg
def test_failed_guest_request_is_reported(client, media_server, monkeypatch):
    monkeypatch.setattr(main, "party", Party())
    client.post("/api/party/request", json={"url": f"{media_server}/nope.mp3", "voter": "ana"})

    def failed():
        p = client.get("/api/party/queue", params={"voter": "ana"}).json()["pending"]
        return p and p[0]["status"] == "failed" and p[0]

    assert "404" in _wait_for(failed)["error"]


def test_bad_request_url_is_rejected_at_once(client):
    assert client.post("/api/party/request", json={"url": "not a link"}).status_code == 400
