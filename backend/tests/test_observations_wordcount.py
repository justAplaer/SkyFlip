"""Word-count rule: 300 accepted, 301 rejected; whitespace / empty / non-ASCII."""

from __future__ import annotations

from app.observations.wordcount import MAX_WORDS, count_words, words_over_limit


def test_empty_and_whitespace():
    assert count_words("") == 0
    assert count_words("   \t\n  ") == 0
    assert count_words("\u00a0\u00a0") == 0  # NBSP only


def test_simple_english():
    assert count_words("one two three") == 3
    assert count_words("  one   two\nthree  ") == 3


def test_tabs_newlines_multiple_spaces():
    assert count_words("a\tb\nc   d") == 4


def test_exactly_300_and_301():
    words_300 = " ".join(f"w{i}" for i in range(MAX_WORDS))
    words_301 = words_300 + " extra"
    assert count_words(words_300) == 300
    assert words_over_limit(words_300) == 0
    assert count_words(words_301) == 301
    assert words_over_limit(words_301) == 1


def test_non_ascii_tokens():
    # Accented Latin still whitespace-split
    assert count_words("café naïve résumé") == 3
    # Continuous CJK without spaces → one token under documented rule
    assert count_words("移动天体") == 1
    assert count_words("移动 天体") == 2


def test_control_characters_do_not_inflate():
    assert count_words("hello\x00world") == 2
