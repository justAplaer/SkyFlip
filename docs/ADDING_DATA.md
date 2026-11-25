# Adding / refreshing SPHEREx demo data

SkyFlip’s five official targets are cached under `frontend/public/demo-data/<target_id>/`.

## One command

```bash
make refresh
```

This runs `pipeline/refresh_data.py`: stage new cutouts from the latest IRSA SPHEREx
release → validate → swap into `demo-data`. On failure, the previous cache is kept.

Alias: `make refresh-data`.

## What changes

The refresh script prints which `obs_id`s were added/removed per target and updates
`manifest.json`, PNG/float packs, and the validation scoreboard when configured.

## Live vs cached

- **LIVE IRSA** — `/api/cutouts` hits SIA/IBE (see `docs/DATA_NOTES.md`).
- **CACHED** — offline demo packs; always labeled in the UI status pills.

Do not invent coordinates or proper motions. Update `frontend/public/demo-data/pm_table.json`
only with cited catalog values.
