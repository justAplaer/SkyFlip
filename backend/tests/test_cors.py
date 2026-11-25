"""CORS allowlist must never be '*'."""

from __future__ import annotations

import pytest

from app.main import _cors_allow_origins


def test_cors_default_localhost_only(monkeypatch):
    monkeypatch.delenv("SKYFLIP_CORS_ORIGINS", raising=False)
    origins = _cors_allow_origins()
    assert "*" not in origins
    assert "http://localhost:5173" in origins
    assert "http://127.0.0.1:5173" in origins


def test_cors_env_allowlist(monkeypatch):
    monkeypatch.setenv(
        "SKYFLIP_CORS_ORIGINS",
        "http://localhost:5173,https://my-app.vercel.app",
    )
    origins = _cors_allow_origins()
    assert origins == [
        "http://localhost:5173",
        "https://my-app.vercel.app",
    ]


def test_cors_rejects_star(monkeypatch):
    monkeypatch.setenv("SKYFLIP_CORS_ORIGINS", "*,http://localhost:5173")
    with pytest.raises(RuntimeError, match="must not contain"):
        _cors_allow_origins()
