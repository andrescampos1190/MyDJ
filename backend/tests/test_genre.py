import pytest

from genre import guess_genre


@pytest.mark.parametrize(
    "info,expected",
    [
        ({"genre": "Tech House"}, "Tech House"),  # SoundCloud-style field
        ({"genre": "deep house"}, "Deep House"),
        ({"genres": ["Hip-Hop/Rap"]}, "Hip-Hop"),  # YouTube Music-style list
        ({"genre": "Ambient"}, "Ambient"),  # unlisted but real -> kept as-is
        ({"tags": ["bad bunny", "reggaeton 2026", "perreo"]}, "Reggaeton"),
        ({"tags": ["liquid dnb", "house"]}, "Drum & Bass"),  # specific beats generic
        ({"title": "Artist - Song (Afro House Remix)"}, "Afro House"),
        ({"title": "Romeo Santos - Propuesta Indecente (Bachata)"}, "Bachata"),
        ({"tags": ["music video", "official"], "title": "Some Song"}, None),
        ({}, None),
    ],
)
def test_guess_genre(info, expected):
    assert guess_genre(info) == expected


def test_declared_genre_wins_over_tags():
    assert guess_genre({"genre": "Techno", "tags": ["house"]}) == "Techno"


def test_words_inside_other_words_dont_match():
    # "house" inside "warehouse", "rap" inside "trapeze", "pop" inside "popular"
    assert guess_genre({"title": "Warehouse trapeze popular"}) is None
