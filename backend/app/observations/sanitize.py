"""Sanitize untrusted user text for storage (never execute / never trust as HTML)."""

from __future__ import annotations

import html
import re
import unicodedata

# Strip most C0/C1 controls; keep tab/newline mapped to space for descriptions
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_MAX_STR = 8000  # hard cap on any single free-text field after sanitize


def sanitize_text(value: str | None, *, max_len: int = _MAX_STR) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    s = unicodedata.normalize("NFKC", value)
    s = _CTRL.sub("", s)
    # Soften overlong input for storage (validation should already reject);
    # truncate only as a defense-in-depth last resort with marker.
    if len(s) > max_len:
        s = s[:max_len]
    return s


def escape_for_output(value: str) -> str:
    """HTML-escape for any template/admin HTML context. Prefer plain text rendering."""
    return html.escape(value or "", quote=True)


def looks_like_spam(text: str) -> bool:
    """Heuristic flag only — never silently delete."""
    t = (text or "").lower()
    if t.count("http://") + t.count("https://") + t.count("www.") >= 3:
        return True
    if re.search(r"(viagra|crypto\s*airdrop|click\s*here\s*now)", t):
        return True
    return False
