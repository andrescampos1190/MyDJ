"""Best-effort genre from a track's yt-dlp metadata — free, no API key.

Some sites ship a genre (SoundCloud's `genre`, YouTube Music's `genres`); most
YouTube uploads don't, but their uploader tags and titles often name one
("Tech House", "Reggaeton", "Drum & Bass"). Returns None when nothing matches;
AI Polish can still label those tracks.
"""

import re

# (label, pattern) — most specific first, so "tech house" wins over "house".
_GENRES = [
    ("Tech House", r"tech[\s-]?house"),
    ("Deep House", r"deep[\s-]?house"),
    ("Progressive House", r"progressive[\s-]?house"),
    ("Afro House", r"afro[\s-]?house"),
    ("Drum & Bass", r"drum\s*(?:&|and|n|'n')\s*bass|\bdnb\b|\bd&b\b|jungle"),
    ("Dubstep", r"dubstep|riddim"),
    ("Amapiano", r"amapiano"),
    ("Afrobeats", r"afro[\s-]?beats?|afropop|afro[\s-]?pop"),
    ("Reggaeton", r"reggaeton|regueton|perreo|dembow"),
    ("Dancehall", r"dancehall"),
    ("Bachata", r"bachata"),
    ("Salsa", r"\bsalsa\b"),
    ("Cumbia", r"cumbia"),
    ("Merengue", r"merengue"),
    ("Corridos", r"corridos?(?:\s+tumbados?)?|regional mexicano"),
    ("K-Pop", r"k[\s-]?pop"),
    ("Trance", r"trance"),
    ("Techno", r"techno"),
    ("Disco", r"\bdisco\b|nu[\s-]?disco"),
    ("Funk", r"\bfunk\b|funky"),
    ("Hip-Hop", r"hip[\s-]?hop|\brap\b|\btrap\b|drill"),
    ("R&B", r"\br\s*&\s*b\b|\brnb\b|rhythm and blues"),
    ("House", r"\bhouse\b"),
    ("EDM", r"\bedm\b|electro house|big room|electronic dance"),
    ("Latin", r"\blatin[oa]?\b|musica latina"),
    ("Rock", r"\brock\b"),
    ("Pop", r"\bpop\b"),
]
_COMPILED = [(label, re.compile(pat, re.IGNORECASE)) for label, pat in _GENRES]


def _match(text: str) -> str | None:
    for label, rx in _COMPILED:
        if rx.search(text):
            return label
    return None


def guess_genre(info: dict) -> str | None:
    """Genre for a yt-dlp info dict: the site's own field, then tags, then the title."""
    declared = [info.get("genre")] + list(info.get("genres") or [])
    declared = [g.strip() for g in declared if isinstance(g, str) and g.strip()]
    for g in declared:
        if label := _match(g):
            return label
    if declared and len(declared[0]) <= 24:
        return declared[0].title()  # a real genre we don't list (e.g. "Ambient")

    tags = " | ".join(t for t in (info.get("tags") or []) if isinstance(t, str))
    for text in (tags, info.get("title") or ""):
        if text and (label := _match(text)):
            return label
    return None
