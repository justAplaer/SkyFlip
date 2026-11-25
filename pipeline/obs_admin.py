#!/usr/bin/env python3
"""CLI: list / filter / export community observations (token via env)."""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.observations.auth import check_admin_token  # noqa: E402
from app.observations.service import aggregate_by_sky, list_submissions  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description="SkyFlip observation admin CLI")
    p.add_argument("command", choices=["list", "export", "aggregate"])
    p.add_argument("--status")
    p.add_argument("--target")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--format", choices=["json", "csv"], default="json")
    p.add_argument("--out", type=Path)
    args = p.parse_args()

    token = os.environ.get("SKYFLIP_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN")
    if not check_admin_token(token):
        print("Set SKYFLIP_ADMIN_TOKEN to a valid admin token.", file=sys.stderr)
        sys.exit(1)

    if args.command == "list":
        rows = list_submissions(status=args.status, target_id=args.target, limit=args.limit)
        print(json.dumps(rows, indent=2))
    elif args.command == "export":
        rows = list_submissions(status=args.status, target_id=args.target, limit=args.limit)
        if args.format == "json":
            text = json.dumps(rows, indent=2)
            if args.out:
                args.out.write_text(text, encoding="utf-8")
            else:
                print(text)
        else:
            fields = [
                "submission_id",
                "created_at",
                "status",
                "target_id",
                "ra",
                "dec",
                "word_count",
                "confidence",
                "direction",
                "is_synthetic",
            ]
            out = open(args.out, "w", newline="", encoding="utf-8") if args.out else sys.stdout
            w = csv.DictWriter(out, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow(r)
            if args.out:
                out.close()
    elif args.command == "aggregate":
        print(json.dumps(aggregate_by_sky(), indent=2))


if __name__ == "__main__":
    main()
