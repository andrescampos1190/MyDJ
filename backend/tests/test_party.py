import main
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


def test_inbox_is_handed_to_the_host_once():
    p = Party()
    p.request({"id": ID, "title": "Song", "addedBy": "Ana"})
    assert p.view("x")["pending"] == [{"title": "Song", "addedBy": "Ana"}]
    assert [t["id"] for t in p.sync({})["requests"]] == [ID]
    assert p.sync({})["requests"] == []
    assert p.view("x")["pending"] == []


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
    assert all(not a.startswith("127.") for a in addrs)


@needs_ffmpeg
def test_guest_request_reaches_the_host(client, media_server):
    main.party = Party()  # fresh session
    r = client.post("/api/party/request",
                    json={"url": f"{media_server}/A_minor.mp3", "name": " Ana "})
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    synced = client.post("/api/party/sync", json={"snapshot": {}}).json()
    (track,) = synced["requests"]
    assert track["id"] == tid and track["addedBy"] == "Ana" and track["camelot"] == "8A"
    assert track["audioUrl"] == f"/api/audio/{tid}"
    assert synced["scores"] == {}  # requests start unvoted
