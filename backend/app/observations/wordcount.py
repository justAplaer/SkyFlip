"""
Shared word-count rule for observation descriptions.

Rule (client and server MUST match):
1. Unicode NFKC normalize the string.
2. Replace control characters (except ordinary whitespace) with a space.
3. Collapse all Unicode whitespace (space, tab, newline, NBSP, …) to separators.
4. Split on whitespace; discard empty tokens.
5. Each non-empty token counts as **one word**.

Scripts without spaces (e.g. continuous CJK): each contiguous non-whitespace
run still counts as one word under this rule. Language-specific tokenizers are
not used (TODO(VERIFY) if researchers need character-level CJK counting later).

Empty / whitespace-only input → 0 words.
"""

from __future__ import annotations

import re
import unicodedata

MAX_WORDS = 300

# All Unicode whitespace (including NBSP, etc.)
_WS_RE = re.compile(r"\s+", re.UNICODE)
# C0/C1 controls and DEL, but we first map them to spaces via category Cc
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def normalize_for_count(text: str) -> str:
    if not isinstance(text, str):
        text = str(text) if text is not None else ""
    s = unicodedata.normalize("NFKC", text)
    # Map other control chars to space; keep \t \n \r as whitespace
    out: list[str] = []
    for ch in s:
        if ch in "\t\n\r":
            out.append(" ")
        elif unicodedata.category(ch) == "Cc":
            out.append(" ")
        else:
            out.append(ch)
    return "".join(out)


def count_words(text: str) -> int:
    """Return word count per the documented rule."""
    s = normalize_for_count(text).strip()
    if not s:
        return 0
    tokens = [t for t in _WS_RE.split(s) if t]
    return len(tokens)


def words_over_limit(text: str, limit: int = MAX_WORDS) -> int:
    """How many words over the limit (0 if within limit)."""
    n = count_words(text)
    return max(0, n - limit)


def assert_within_limit(text: str, limit: int = MAX_WORDS) -> None:
    over = words_over_limit(text, limit)
    if over:
        raise ValueError(
            f"Description exceeds {limit} words "
            f"(got {count_words(text)}; {over} over limit). "
            "Do not silently truncate — shorten the text."
        )
