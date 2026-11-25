"""Admin token auth — constant-time compare; token from env only."""

from __future__ import annotations

import hmac
import os
from typing import Optional


def admin_token_from_env() -> Optional[str]:
    tok = os.environ.get("SKYFLIP_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN")
    if tok is None or tok.strip() == "":
        return None
    return tok.strip()


def check_admin_token(provided: Optional[str]) -> bool:
    """
    Return True iff configured and matches.
    Missing env token → no admin access (False).
    Wrong/missing provided → False. Uses hmac.compare_digest.
    """
    expected = admin_token_from_env()
    if expected is None:
        return False
    if provided is None:
        return False
    a = provided.encode("utf-8")
    b = expected.encode("utf-8")
    if len(a) != len(b):
        # still compare to keep rough timing flat for equal-length attempts
        return hmac.compare_digest(a[:0], b[:0]) and False
    return hmac.compare_digest(a, b)
