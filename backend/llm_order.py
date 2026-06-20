"""Optional LLM playlist ordering via the Anthropic SDK ("AI Polish").

Sequences the analyzed tracks into a party set: tags each track's genre, builds
genre blocks with gradual tempo ramps between them, and follows the harmonic +
energy-arc rules. We validate the output (known ids only); the frontend appends
any it omitted and shows the per-track genre on the chips.
"""

import json

from pydantic import BaseModel

MODEL = "claude-opus-4-8"  # change to claude-sonnet-4-6 / claude-haiku-4-5 for cheaper runs


class OrderedTrack(BaseModel):
    id: str
    genre: str  # short label, e.g. "House", "Hip-Hop", "Reggaeton"


class OrderResult(BaseModel):
    order: list[OrderedTrack]  # tracks in final play order


def _build_prompt(tracks: list[dict]) -> str:
    return (
        "You are an expert DJ sequencing a playlist for a multi-genre party. For EACH "
        "track, identify its genre, then order the whole set so it flows like a real DJ set.\n\n"
        "Rules:\n"
        "1. GENRE: label each track (e.g. House, Tech House, Disco, Hip-Hop, Reggaeton, Pop, "
        "Afrobeats, DnB...). Group same/related genres into CONTIGUOUS BLOCKS so the floor "
        "isn't whiplashed between styles every track.\n"
        "2. WITHIN a block: keep adjacent tracks Camelot-compatible (same code, +/-1 same "
        "letter, or relative major/minor A<->B) and BPM within ~6%.\n"
        "3. BETWEEN blocks (a genre change): put the switch where the BPM gap is smallest, and "
        "order the boundary tracks so tempo RAMPS gradually across it (don't jump 90 -> 174 "
        "abruptly; bridge with mid-tempo tracks or a half/double-time pair).\n"
        "4. ENERGY (1-10): shape the night overall - warm-up (~5) -> build -> peak around 70% "
        "through -> ease down. Keep energy steps small (~1 level) between neighbours.\n\n"
        "Use ONLY the provided bpm/camelot/energy values; do not invent data. Return EVERY "
        "track's id with its genre, in the final play order.\n\n"
        f"Tracks (JSON):\n{json.dumps(tracks, ensure_ascii=False, indent=1)}"
    )


def order_tracks(tracks: list[dict]) -> list[dict]:
    # Lazy import so the backend still boots if `anthropic` isn't installed.
    from anthropic import Anthropic

    # Bounded timeout/retries so a slow or stuck call can't wedge the worker; the
    # token budget comfortably covers a large (~150-track) set of {id, genre}.
    client = Anthropic(timeout=120.0, max_retries=2)  # reads ANTHROPIC_API_KEY from env
    resp = client.messages.parse(
        model=MODEL,
        max_tokens=8000,
        messages=[{"role": "user", "content": _build_prompt(tracks)}],
        output_format=OrderResult,
    )
    valid = {t.get("id") for t in tracks}
    seen, out = set(), []
    if resp.parsed_output:
        for o in resp.parsed_output.order:
            if o.id in valid and o.id not in seen:
                seen.add(o.id)
                out.append({"id": o.id, "genre": o.genre})
    return out
