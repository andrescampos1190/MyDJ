"""Shared party session: friends on the same Wi-Fi add songs and vote from their phones.

The host's browser plays the music and owns the queue; this is the meeting point.
Guests' requests are downloaded + analyzed in the background (phones see live status),
then wait in an inbox until the host's next sync. The host publishes a snapshot of its
queue for guests to see, votes are kept per track, and both sides see who's connected.
In memory: one party per backend process, gone on restart.
"""

import socket
import threading
import time
import uuid

HOST_TIMEOUT = 10  # s without a host sync before phones say the DJ's app isn't connected
GUEST_TIMEOUT = 10  # s without a poll before a phone stops counting as connected
FAILED_TTL = 120  # s a failed request stays visible to the friend who made it


class Party:
    def __init__(self):
        self._lock = threading.Lock()
        self._requests: dict[str, dict] = {}  # rid -> request in progress / failed / ready
        self._inbox: list[dict] = []  # ready tracks the host hasn't picked up yet
        self._votes: dict[str, dict[str, int]] = {}  # track id -> {voter id: +1 | -1}
        self._guests: dict[str, dict] = {}  # voter id -> {name, seen}
        self._snapshot: dict = {}  # host's latest queue (see Engine.partySnapshot)
        self._host_seen = 0.0

    # ---- song requests: start -> (finish | fail) -> picked up by the host's sync ----
    def start_request(self, title: str | None, name: str, voter: str) -> str:
        rid = uuid.uuid4().hex
        with self._lock:
            self._requests[rid] = {"rid": rid, "title": title, "addedBy": name, "voter": voter,
                                   "status": "downloading", "error": None, "at": time.time()}
        return rid

    def finish_request(self, rid: str, track: dict) -> None:
        with self._lock:
            req = self._requests.pop(rid, None)
            if req is None:
                return
            track = {**track, "addedBy": req["addedBy"], "rid": rid}
            self._inbox.append(track)

    def fail_request(self, rid: str, error: str) -> None:
        with self._lock:
            if rid in self._requests:
                self._requests[rid].update(status="failed", error=error, at=time.time())

    def vote(self, track_id: str, voter: str, value: int) -> None:
        with self._lock:
            votes = self._votes.setdefault(track_id, {})
            if value:
                votes[voter] = 1 if value > 0 else -1
            else:
                votes.pop(voter, None)

    def _scores(self) -> dict[str, int]:
        return {tid: sum(v.values()) for tid, v in self._votes.items() if v}

    def _connected(self, now: float) -> list[str]:
        return sorted(g["name"] for g in self._guests.values() if now - g["seen"] < GUEST_TIMEOUT)

    def sync(self, snapshot: dict) -> dict:
        """Host heartbeat: store its queue, hand over ready requests, votes and who's here."""
        with self._lock:
            now = time.time()
            self._snapshot = snapshot or {}
            self._host_seen = now
            requests, self._inbox = self._inbox, []
            return {"requests": requests, "scores": self._scores(),
                    "guests": self._connected(now),
                    "working": sum(r["status"] == "downloading" for r in self._requests.values())}

    def view(self, voter: str, name: str = "") -> dict:
        """What a phone shows (and a presence ping): the host's queue with vote counts and
        this phone's own votes, plus songs on their way in."""
        with self._lock:
            now = time.time()
            if voter:
                self._guests[voter] = {"name": name or "Guest", "seen": now}
            for rid in [r for r, q in self._requests.items()
                        if q["status"] == "failed" and now - q["at"] > FAILED_TTL]:
                del self._requests[rid]
            scores = self._scores()
            snap = self._snapshot

            def tag(t):
                if not t:
                    return None
                return {**t, "score": scores.get(t["id"], 0),
                        "myVote": self._votes.get(t["id"], {}).get(voter, 0)}

            def pending(q, status):
                return {"rid": q["rid"], "title": q.get("title"), "addedBy": q["addedBy"],
                        "status": status, "error": q.get("error"),
                        "mine": bool(voter) and q.get("voter") == voter}

            incoming = [pending(q, q["status"]) for q in self._requests.values()
                        if q["status"] == "downloading" or q["voter"] == voter]
            incoming += [pending({**t, "voter": None}, "ready") for t in self._inbox]
            return {
                "hostOnline": now - self._host_seen < HOST_TIMEOUT,
                "hostSeenAgo": round(now - self._host_seen) if self._host_seen else None,
                "playing": bool(snap.get("playing")),
                "now": tag(snap.get("now")),
                "next": tag(snap.get("next")),
                "upcoming": [tag(t) for t in snap.get("upcoming") or []],
                "progress": snap.get("progress"),  # {pos, dur, mixAt, mixing} of the song playing
                "pending": incoming,
                "guests": self._connected(now),
            }


def lan_addresses() -> list[str]:
    """This machine's addresses on the local network, for the guests' join link. The one
    on the default route (normally the Wi-Fi/Ethernet the phones share) comes first;
    virtual adapters (WSL, Hyper-V, VPNs) can otherwise look like a valid choice."""
    primary = None
    try:  # the OS picks the outgoing interface; a UDP "connect" sends no packets
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            primary = s.getsockname()[0]
    except OSError:
        pass
    others = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            others.add(info[4][0])
    except OSError:
        pass
    ordered = ([primary] if primary else []) + sorted(others - {primary})
    return [ip for ip in ordered if ip and not ip.startswith(("127.", "169.254.", "0."))]
