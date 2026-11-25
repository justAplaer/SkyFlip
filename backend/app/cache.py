"""Simple on-disk cache helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CACHE = Path(os.environ.get("SKYFLIP_CACHE_DIR", ROOT / ".cache"))
DEMO_DATA = Path(
    os.environ.get(
        "SKYFLIP_DEMO_DATA",
        ROOT / "frontend" / "public" / "demo-data",
    )
)


def cache_root() -> Path:
    DEFAULT_CACHE.mkdir(parents=True, exist_ok=True)
    return DEFAULT_CACHE


def demo_data_available() -> bool:
    if not DEMO_DATA.exists():
        return False
    # Expect at least one target folder or manifest.
    return any(DEMO_DATA.iterdir())


def read_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
