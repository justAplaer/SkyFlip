#!/usr/bin/env python3
"""Live IRSA connectivity check for SkyFlip.

Run with the API up (make backend) and network available:

  python scripts/check_live.py

Prints PASS/FAIL for each step. Exit code 0 only if all required steps pass.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

API = "http://127.0.0.1:8000"
WISE = {"ra": 133.76047590770844, "dec": -7.24216033045264, "name": "WISE 0855"}


def step(name: str, fn) -> bool:
    try:
        detail = fn()
        print(f"PASS  {name}" + (f" — {detail}" if detail else ""))
        return True
    except Exception as exc:
        print(f"FAIL  {name} — {exc}")
        return False


def http_json(path: str, timeout: float = 60.0):
    req = urllib.request.Request(f"{API}{path}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    results: list[bool] = []

    results.append(
        step("GET /api/health", lambda: http_json("/api/health", 5).get("status"))
    )

    results.append(
        step(
            "resolve WISE 0855",
            lambda: (
                lambda d: f"ra={d['ra']:.4f} dec={d['dec']:.4f}"
            )(http_json(f"/api/resolve?name={urllib.parse.quote(WISE['name'])}", 30)),
        )
    )

    def list_epochs():
        q = urllib.parse.urlencode(
            {"ra": WISE["ra"], "dec": WISE["dec"], "fov": 0.05, "target": "wise0855"}
        )
        d = http_json(f"/api/epochs?{q}", 90)
        n = len(d.get("epochs") or [])
        if n < 1:
            raise RuntimeError("no epochs")
        return f"{n} epochs, source={d.get('source')}"

    results.append(step("list epochs for WISE 0855", list_epochs))

    def one_full_frame():
        q = urllib.parse.urlencode(
            {
                "ra": WISE["ra"],
                "dec": WISE["dec"],
                "fov": 0.05,
                "target": "wise0855",
                "view_mode": "full_frame",
                "subtract_zodi": "false",
                "max_frames": 2,
            }
        )
        d = http_json(f"/api/cutouts?{q}", 300)
        frames = d.get("frames") or []
        if not frames:
            raise RuntimeError("no full frames")
        f0 = frames[0]
        meta_url = f0.get("frame_meta_url")
        if not meta_url:
            raise RuntimeError("missing frame_meta_url")
        meta = http_json(meta_url if meta_url.startswith("/api") else f"/api/{meta_url}", 120)
        shape = meta.get("shape") or [meta.get("naxis2"), meta.get("naxis1")]
        # Fetch one coarse tile
        obs = f0["obs_id"]
        det = f0["detector"]
        level = max(0, int(meta.get("n_levels", 1)) - 1)
        tile_path = f"/api/frame/{urllib.parse.quote(obs)}/{det}/tile/{level}/0/0?subtract_zodi=false"
        req = urllib.request.Request(f"{API}{tile_path}")
        with urllib.request.urlopen(req, timeout=120) as resp:
            blob = resp.read()
        if len(blob) < 16:
            raise RuntimeError("empty tile")
        return f"shape={shape}, tile_bytes={len(blob)}, source={d.get('source')}"

    results.append(step("download one full frame + tile", one_full_frame))

    ok = all(results)
    print("---")
    print("ALL PASS" if ok else "SOME FAILED — app should fall back to Cached demo data")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.URLError as exc:
        print(f"FAIL  cannot reach {API}: {exc}")
        print("Start the API with: make backend")
        raise SystemExit(2) from exc
