# SkyFlip API (contract)

See `backend/app/models.py` for the source of truth.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | IRSA / SIMBAD / demo cache status |
| GET | `/api/resolve?name=` | Sesame/SIMBAD |
| GET | `/api/epochs?ra=&dec=&fov=` | SIA epoch list |
| GET | `/api/cutouts?...` | Live SIA/IBE or cached demo; optional `stack`, `wavelength_tol_um` |
| GET | `/api/diff?ra=&dec=&a=&b=&bandpass=&wavelength_tol_um=` | Refuses science PNG when `|Δλ|` exceeds tol (`wavelength_mismatched`) |
| GET | `/api/movers?...` | Detect + classify tracks |
| GET | `/api/predicted-track?...` | PM ghost + historical markers |
| GET | `/api/spectrum?...` | Cube path when available; honesty notes if not |
| GET | `/api/change-scores?...` | Per-frame change metrics; λ-matched peers |
| GET | `/api/pixel?target=&epoch_id=&x=&y=` | Demo float IMAGE + FLAGS at pixel; VARIANCE/ZODI not packed → not computed |
| GET | `/api/scoreboard` | Validation scoreboard (variables excluded from mover recovery) |
| POST | `/api/observations` | Report-an-observation |

All cutout/score responses include `source`: `live` or `cached-demo`.

**UI modes (frontend):** `?mode=expert` enables View/Analysis menus, pixel inspector, Aladin, movers/spectrum panels. Default is Simple (mode omitted from URL).
