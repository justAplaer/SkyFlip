# Live IRSA check

SkyFlip prefers live SPHEREx SIA/IBE data and falls back to labeled **Cached** demo packs when a live step fails.

## Run

1. Start the API: `make backend` (listens on `http://127.0.0.1:8000`).
2. With network access:

```bash
python scripts/check_live.py
```

## Steps reported

| Step | Meaning |
| --- | --- |
| `GET /api/health` | API process is up |
| `resolve WISE 0855` | Name resolver works |
| `list epochs for WISE 0855` | SIA finds covering Spectral Images |
| `download one full frame + tile` | Full MEF download, pyramid build, one float tile |

Exit code `0` = all PASS. Non-zero = at least one FAIL — the UI should show the **Cached** badge and serve offline demo frames instead of pretending they are live.
