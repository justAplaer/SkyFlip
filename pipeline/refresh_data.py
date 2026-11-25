#!/usr/bin/env python3
"""Safe demo-data refresh: stage → validate → atomic swap.

Never deletes frontend/public/demo-data until the new pack is complete.
On failure, the previous demo-data directory is left untouched.

Usage:
  make refresh-data
  SKYFLIP_PRECACHE_ONLY=wise0855 .venv/bin/python pipeline/refresh_data.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "frontend" / "public" / "demo-data"
STAGING = ROOT / "tmp" / "demo-data-staging"
BACKUP = ROOT / "tmp" / "demo-data-backup"
PYTHON = ROOT / ".venv" / "bin" / "python"
MAX_ATTEMPTS = 3


def _run(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=ROOT, check=True, env=env)


def _required_targets() -> list[str]:
    only = (os.environ.get("SKYFLIP_PRECACHE_ONLY") or "").strip()
    if only:
        return [x.strip() for x in only.split(",") if x.strip()]
    return [
        "wise0855",
        "barnards_star",
        "epsilon_indi_b",
        "rw_aurigae",
        "r_draconis",
    ]


def _merge_json_by_id(
    backup_path: Path,
    demo_path: Path,
    list_key: str | None,
    id_key: str,
) -> None:
    """Merge list-of-objects from backup into demo so partial refresh keeps siblings."""
    if not backup_path.exists() or not demo_path.exists():
        return
    try:
        backup = json.loads(backup_path.read_text(encoding="utf-8"))
        demo = json.loads(demo_path.read_text(encoding="utf-8"))
    except Exception:
        return
    if list_key is None:
        # visibility_report.json is a bare list
        if not isinstance(backup, list) or not isinstance(demo, list):
            return
        by = {row.get(id_key): row for row in backup if isinstance(row, dict)}
        for row in demo:
            if isinstance(row, dict) and row.get(id_key):
                by[row[id_key]] = row
        order = [
            "wise0855",
            "barnards_star",
            "epsilon_indi_b",
            "rw_aurigae",
            "r_draconis",
        ]
        merged = [by[i] for i in order if i in by] + [by[k] for k in by if k not in order]
        demo_path.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        return
    if not isinstance(backup, dict) or not isinstance(demo, dict):
        return
    b_list = backup.get(list_key) or []
    d_list = demo.get(list_key) or []
    by = {row.get(id_key): row for row in b_list if isinstance(row, dict)}
    for row in d_list:
        if isinstance(row, dict) and row.get(id_key):
            by[row[id_key]] = row
    order = [
        "wise0855",
        "barnards_star",
        "epsilon_indi_b",
        "rw_aurigae",
        "r_draconis",
    ]
    demo[list_key] = [by[i] for i in order if i in by] + [
        by[k] for k in by if k not in order
    ]
    demo_path.write_text(json.dumps(demo, indent=2) + "\n", encoding="utf-8")


def _staging_looks_complete(stage: Path, targets: list[str]) -> list[str]:
    missing: list[str] = []
    for tid in targets:
        man = stage / tid / "manifest.json"
        if not man.exists():
            missing.append(f"{tid}/manifest.json")
            continue
        # At least one frame asset
        pngs = list((stage / tid).glob("frame_*.png"))
        if len(pngs) < 2:
            missing.append(f"{tid}: need ≥2 frame_*.png (found {len(pngs)})")
    for name in ("index.json", "pm_table.json"):
        if not (stage / name).exists():
            # index.json is written by precache; pm_table may already live in DEMO
            if name == "pm_table.json" and (DEMO / name).exists():
                continue
            if name == "index.json":
                missing.append(name)
    return missing


def main() -> int:
    if not PYTHON.exists():
        print("Missing .venv — run `make install` first", file=sys.stderr)
        return 2

    targets = _required_targets()
    print(f"refresh-data start {datetime.now(timezone.utc).isoformat()} targets={targets}")

    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.mkdir(parents=True, exist_ok=True)

    # Point precache at staging via env override (precache_targets reads OUT or this).
    env = os.environ.copy()
    env["SKYFLIP_DEMO_DATA_OUT"] = str(STAGING)
    # Keep network retries visible
    env.setdefault("SKYFLIP_PRECACHE_ONLY", ",".join(targets) if targets else "")

    last_err: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            print(f"precache attempt {attempt}/{MAX_ATTEMPTS}", flush=True)
            _run([str(PYTHON), "pipeline/precache_targets.py"], env=env)
            # Curated SSOT: always restore from live demo (overwrite any thin staging copy).
            for name in ("pm_table.json", "crossmatch_cache.json", "synthetic_movers.json"):
                src = DEMO / name
                if src.exists():
                    shutil.copy2(src, STAGING / name)
            missing = _staging_looks_complete(STAGING, targets)
            if missing:
                raise RuntimeError("staging incomplete: " + "; ".join(missing))
            last_err = None
            break
        except Exception as exc:
            last_err = exc
            print(f"attempt {attempt} failed: {exc}", flush=True)
            time.sleep(min(60, 5 * attempt))

    if last_err is not None:
        print(
            "REFRESH FAILED — leaving existing demo-data untouched.",
            file=sys.stderr,
        )
        print(f"Staging kept for inspection at {STAGING}", file=sys.stderr)
        return 1

    # Optional validation / synthetic inject into staging if scripts honor OUT
    try:
        env_val = env.copy()
        env_val["SKYFLIP_DEMO_DATA"] = str(STAGING)
        _run([str(PYTHON), "pipeline/run_validation.py"], env=env_val)
    except Exception as exc:
        print(f"validation warning (non-fatal for swap): {exc}", flush=True)

    # Atomic-ish swap: move current demo → backup, staging → demo
    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    if BACKUP.exists():
        shutil.rmtree(BACKUP)
    if DEMO.exists():
        DEMO.rename(BACKUP)
    try:
        STAGING.rename(DEMO)
    except Exception:
        # Restore backup if rename of staging failed
        if BACKUP.exists() and not DEMO.exists():
            BACKUP.rename(DEMO)
        raise

    # Restore anything staging lacked (other targets on partial refresh, extras).
    if BACKUP.exists():
        for p in BACKUP.iterdir():
            dest = DEMO / p.name
            if not dest.exists():
                if p.is_dir():
                    shutil.copytree(p, dest)
                else:
                    shutil.copy2(p, dest)
        # Partial precache writes thin JSON — merge sibling target rows back.
        _merge_json_by_id(BACKUP / "index.json", DEMO / "index.json", "targets", "id")
        _merge_json_by_id(
            BACKUP / "visibility_report.json",
            DEMO / "visibility_report.json",
            None,
            "target_id",
        )
        # pm_table is curated SSOT — never let a thin staging rewrite win.
        if (BACKUP / "pm_table.json").exists():
            shutil.copy2(BACKUP / "pm_table.json", DEMO / "pm_table.json")
        # Re-validate on the full restored pack (staging may have only 1 target).
        try:
            env_full = os.environ.copy()
            env_full["SKYFLIP_DEMO_DATA"] = str(DEMO)
            _run([str(PYTHON), "pipeline/run_validation.py"], env=env_full)
        except Exception as exc:
            print(f"post-merge validation warning: {exc}", flush=True)
        try:
            _run([str(PYTHON), "pipeline/precache_change_scores.py"])
        except Exception as exc:
            print(f"change_scores warning (non-fatal): {exc}", flush=True)

    stamp = DEMO / "REFRESH_STAMP.txt"
    stamp.write_text(
        f"refreshed_utc={datetime.now(timezone.utc).isoformat()}\n"
        f"targets={','.join(targets)}\n"
        f"previous_backup={BACKUP}\n",
        encoding="utf-8",
    )
    print(f"refresh-data OK → {DEMO}")
    print(f"previous pack at {BACKUP} (delete manually when satisfied)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
