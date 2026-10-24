"""Shared party session: friends on the same Wi-Fi add songs and vote from their phones.

The host's browser plays the music and owns the queue; this is the meeting point.
Guests' requests (already downloaded + analyzed) wait in an inbox until the host's
next sync, the host publishes a snapshot of its queue for guests to see, and votes are
kept per track. In memory: one party per backend process, gone on restart.
"""

import socket
import threading
import time

HOST_TIMEOUT = 15  # seconds without a host sync before guests see "host offline"


class Party:
    def __init__(self):
        self._lock = threading.Lock()
        self._inbox: list[dict] = []  # guest-requested tracks the host hasn't picked up yet
        self._votes: dict[str, dict[str, int]] = {}  # track id -> {voter id: +1 | -1}
        self._snapshot: dict = {}  # host's latest queue (see Engine.partySnapshot)
        self._host_seen = 0.0

    def request(self, track: dict) -> None:
        with self._lock:
            self._inbox.append(track)

    def vote(self, track_id: str, voter: str, value: int) -> None:
        with self._lock:
            votes = self._votes.setdefault(track_id, {})
            if value:
                votes[voter] = 1 if value > 0 else -1
            else:
                votes.pop(voter, None)

    def _scores(self) -> dict[str, int]:
        return {tid: sum(v.values()) for tid, v in self._votes.items() if v}

    def sync(self, snapshot: dict) -> dict:
        """Host heartbeat: store its queue, hand over new requests and the vote tally."""
        with self._lock:
            self._snapshot = snapshot or {}
            self._host_seen = time.time()
            requests, self._inbox = self._inbox, []
            return {"requests": requests, "scores": self._scores()}

    def view(self, voter: str) -> dict:
        """What a guest's phone shows: the host's queue plus vote counts and their own votes."""
        with self._lock:
            scores = self._scores()
            snap = self._snapshot

            def tag(t):
                if not t:
                    return None
                return {**t, "score": scores.get(t["id"], 0),
                        "myVote": self._votes.get(t["id"], {}).get(voter, 0)}

            return {
                "hostOnline": time.time() - self._host_seen < HOST_TIMEOUT,
                "playing": bool(snap.get("playing")),
                "now": tag(snap.get("now")),
                "next": tag(snap.get("next")),
                "upcoming": [tag(t) for t in snap.get("upcoming") or []],
                "pending": [{"title": t.get("title"), "addedBy": t.get("addedBy")}
                            for t in self._inbox],
            }


def lan_addresses() -> list[str]:
    """This machine's addresses on the local network, for the guests' join link."""
    ips = set()
    try:  # the OS picks the outgoing interface; a UDP "connect" sends no packets
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))
