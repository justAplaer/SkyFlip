# SkyFlip — Project Audit (Phase 1, refreshed)

**Date:** 2026-11-14  
**Git HEAD at audit:** `bbbb3f8` (Barnard's saturation display stamp)  
**Prior audits:** `7296fa8` (first Phase 1), Phase 2 `fabbde2`, Phase 3 `1e42f49`  
**Auditor rule:** only facts verified in this repo or against official IRSA docs. Unverified items are `TODO(VERIFY)`.

## Official archive docs consulted (this pass)

- [SPHEREx Data Releases](https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-releases/) (IRSA, **Nov 12, 2026**):
  - **DR1** = Survey 1+2, reprocessed with QR3 pipeline; includes **All-Sky Cube**.
  - **QR3** = Survey 3+4 (weekly since Sep 2026).
  - **DR1 + QR3 supersede QR2** — use DR1/QR3 for new work; QR2 not searchable; do not mix calibrations.
  - **QR1** retired / unavailable.
- [SPHEREx Archive User Guide](https://irsa.ipac.caltech.edu/spherex-archive-documentation/) (Nov 12, 2026): Spectral Images via IRSA; mission 0.75–5 µm.
- Explanatory Supplement (PDF linked from IRSA): MEF HDUs IMAGE / FLAGS / VARIANCE / ZODI / EPSF; Table 16 flag bits — see `docs/DATA_NOTES.md`, `docs/SCIENCE_LIMITS.md`.

SkyFlip adapter collections (verified in code): `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep`. **No QR2.** Access: **SIA2 + IBE cutouts** (TAP skipped by policy).

---

## 1. Existing architecture (verified)

```
frontend (Vite/React, Vitest, Playwright)
    │  HTTP JSON
backend (FastAPI, Astropy, photutils, SQLite observations)
    ├─ adapters/spherex.py     IRSA SIA2 + IBE cutouts
    ├─ adapters/catalogs.py    Sesame/SIMBAD + pm_table SSOT + fixed_sky_cutout_center
    ├─ imaging / detect / classify / change_scores / spectra / validate
    ├─ predicted_track.py + pm_table.py   historical overlay / ghost
    ├─ observations/           report-an-observation
    └─ cache: backend/.cache + frontend/public/demo-data/
pipeline/   precache_targets, refresh_data (stage→swap), validate, inject_movers, …
```

| Layer | Path | Role |
| --- | --- | --- |
| Frontend | `frontend/src/App.tsx` | Viewer / Scoreboard / Discovery; View·Analysis·Share |
| Blink | `frontend/src/components/BlinkPlayer.tsx` | ≤3 Hz, zoom/pan, ghost + historical markers |
| API | `backend/app/main.py` | cutouts, predicted-track, movers, change-scores, spectrum, scoreboard, observations |
| Demo pack | `frontend/public/demo-data/` | Five targets × 8 frames + manifests + scoreboard |

**Removed earlier (cleanup):** ClassroomMode, SkyTour, PlanetXMeter, sonification — confirmed absent from `frontend/src/components/`.

**Still not implemented:** Simple/Expert mode toggle; scientific pixel inspector panel.

---

## 2. Baseline tests (this audit run)

| Suite | Command | Result |
| --- | --- | --- |
| Backend | `.venv/bin/python -m pytest backend/tests -q` | **PASS — 89 passed** (ErfaWarnings on PM without distance) |
| Vitest | `cd frontend && npm test` | **PASS — 42 passed** (9 files) |
| Build | `cd frontend && npm run build` | **PASS** |
| Playwright | `npx playwright test` | **NOT RUN** — Chromium binary missing in this environment (`npx playwright install` required) |
| Live IRSA | — | **NOT RE-PROBED** this minute; prior session SIA/IBE succeeded |
| `make refresh-data` | present in Makefile | **EXISTS** (`pipeline/refresh_data.py`, stage→swap + partial merge) |

---

## 3. Demo-data inventory (measured now)

FOV **0.2°**, **8 frames** each, pixel scale **6.15″**. Top-level `ra`/`dec` = cutout CRVAL; Barnard's also stores `catalog_ra`/`catalog_dec` (Gaia J2016).

| Target | Band | Collections | Shapes notes | Median peak S/N @ pred | Detectable (index) | Scoreboard |
| --- | --- | --- | --- | --- | --- | --- |
| Barnard's Star | D1 | dr1, qr3 | mostly ~117×117; some 113–114 | ≈0.27 (IMAGE blanked) | **True** (FLAGS + PNG display assist) | **1/1 recovered** (8 assist frames) |
| Epsilon Indi B | D5 | dr1, qr3 | includes 44×117 | ≈0.80 | False | 0/1 |
| WISE 0855 | D5 | dr1 | mostly 117×117 | ≈5.0 | True | 0/1 |
| RW Aurigae | D1 | dr1, qr3 | 117×117 | ≈184 | True | **1/1** (variable — still counted as “recovered”) |
| R Draconis | D1 | dr1, deep, qr3_deep | 117×117 | ≈463 | True | 0/1 |

**Field scoreboard:** recovered **2/5**, rate **0.4**. Many false tracks on variables (RW Aur 113 tracks). Synthetic movers remain labeled `is_synthetic`.

**Barnard's science note (verified live earlier this session):** PM mid-span centering is correct; L2 IMAGE at predicted pixel is ~background while FLAGS `SOURCE`/`HALO` mark the star (saturation blanking). PNG uses a **labeled PM display stamp**; float `_image.bin` is unaltered archive IMAGE. See `docs/SCIENCE_LIMITS.md`.

---

## 4. Working features

| Feature | Evidence |
| --- | --- |
| Offline five-target demo | `frontend/public/demo-data/`; live app serves cached pack |
| Blink + archive-look | `BlinkPlayer`, `lib/stretch.ts` |
| High-PM fixed_sky center | `catalogs.fixed_sky_cutout_center`; Barnard's mid-span CRVAL |
| Cache position lock | `sky_match.manifest_center_match` (catalog **or** cutout coords) |
| Safe `make refresh-data` | stage → validate → swap; partial merge of index/visibility/pm_table |
| Historical / ghost overlay | `pm_table.json` + `predicted_track` |
| Change slider / movers / spectrum API | `main.py` routes present |
| Report observation | `/api/observations*` |
| DR1+QR3 only | `SIA_COLLECTIONS` — no QR2 |

---

## 5. Broken / incomplete / scientific risks

| Issue | Severity | Notes |
| --- | --- | --- |
| ε Indi B / WISE / R Dra scoreboard misses | Medium | Honest misses; many false tracks; do not inflate |
| RW Aur counted as mover recovery | **Fixed (Phase 4)** | Variable controls excluded from `recovery_rate` |
| Barnard's photometric S/N still ≪3 | Documented | Display assist only; float science remains blanked |
| Truncated edge cutouts (ε Indi 44×117) | Medium | Precache filters min dim ≥80 for new packs; old frames may remain |
| Wavelength stacks / λ-matched compare | Incomplete | UI has λ tol; stacking needs stricter science docs |
| Spectrum “102 bands” claim risk | Medium | Only if cube path returns 102; SIA cube timed out historically — `TODO(VERIFY)` |
| Simple/Expert mode | Missing | Prompt requirement |
| Scientific pixel inspector | Missing | Prompt requirement |
| Playwright in CI/local sandbox | **Fixed (Phase 6–7)** | `make check` 16/16 e2e |
| All-Sky Cube spectrum path | Unverified | Cube SIA previously timed out 90s |
| Full live IRSA re-pull of all 5 targets | Not this audit | User asked for full dataset pull — **deferred to Phase 3+** after this gate |

---

## 6. Features to preserve vs remove

**Preserve:** RA/Dec search, SIA/IBE live + labeled cache, blink, FOV/detector/targeting, wavelength tol, change slider, historical/ghost, movers, crossmatch, scoreboard (honest), flags, Aladin, Discovery (SIMULATED), report, URL state, `make refresh-data`.

**Already removed:** Classroom / SkyTour / PlanetX meter / sonify.

**Do not remove without verify:** DiscoveryMode, SpectrumPanel (needs cube path honesty), Aladin.

---

## 7. Recommended implementation order (remaining)

1. **Phase 2 gate (docs only if needed):** confirm DATA_NOTES still matches Nov 12 IRSA page (DR1+QR3, no QR2) — mostly done.
2. **Phase 3 data:** optional full `make refresh-data` for all five targets (live IRSA); keep truncated-frame filter; label DR1/QR3 per frame in UI.
3. **Phase 4 science:** variable ≠ mover on scoreboard; wavelength-compatible stack/diff; centroid redesign for Bug 7; pixel inspector backend fields.
4. **Phase 5 UI:** Simple/Expert; coord validation polish; clear preset on custom search; inspector panel; toolbar.
5. **Phase 6–7:** docs/DEMO polish; `npx playwright install` + `make check`; presentation dry-run.

**Do not** destroy demo-data on failed refresh. **Do not** invent IRSA products. **Do not** claim Planet X found.

---

## 8. Phase 1 gate verdict

| Criterion | Status |
| --- | --- |
| Architecture mapped | **PASS** |
| IRSA releases page reviewed | **PASS** (DR1+QR3 supersede QR2) |
| Demo inventory measured | **PASS** |
| Backend + Vitest + build | **PASS** (89 / 42 / build OK) |
| Playwright | **NOT RUN** (browser binary missing) |
| Serious blockers before next work | **None that stop Phase 2/3** — Playwright env + variable-as-mover are known follow-ups |

## 9. Phase 2 gate (dataset / docs verification)

| Criterion | Status |
| --- | --- |
| IRSA Data Releases Nov 12 2026 | **PASS** — DR1+QR3 supersede QR2; QR1 retired |
| Data Products MEF layout | **PASS** — matches adapter parse (IMAGE…WCS-WAVE; EPSF for DR1/QR3) |
| Live SIA+IBE (WISE 0855 D5) | **PASS** — ping 200; 49 DR1 hits; cutout MEF 7 HDUs |
| No QR2 in `SIA_COLLECTIONS` | **PASS** |
| All-Sky Cube SIA | **TODO(VERIFY)** — prior 90s timeout; not blocking Spectral Image path |
| `docs/DATA_NOTES.md` stamped | **PASS** |

## 10. Phase 3 gate (full safe refresh)

| Criterion | Status |
| --- | --- |
| `make refresh-data` all 5 targets | **PASS** — stage→validate→swap; backup at `tmp/demo-data-backup` |
| Frames per target | **PASS** — 8 frames each; mid-span fixed-sky centers |
| Scoreboard honesty | **PASS** — 3/5 recovered (ε Indi B, RW Aur, WISE 0855); Barnard's + R Dra first-class misses |
| Barnard's PNG assist | **PASS** — 5/8 frames `png_display_assist`; float `.bin` unaltered; recovery still 0 (honest) |
| `pm_table.json` SSOT | **PASS** after fix — precache no longer writes thin table; refresh always restores curated SSOT |
| Backend tests | **PASS** — 89 |
| Frontend Vitest | **PASS** — 42 |
| Playwright | **NOT RUN** |

**Refresh stamp:** `2026-11-15T00:02:33Z` (UTC). Demo recommendation: `wise0855`.

## 11. Phase 4 gate (science honesty)

| Criterion | Status |
| --- | --- |
| Variable ≠ mover on scoreboard | **PASS** — RW Aur / R Dra `role=variable_control`; recovery **2/3** (ε Indi + WISE; Barnard's miss) |
| Scoreboard UI separates controls | **PASS** — `ScoreboardPanel` known-mover vs variable sections |
| Wavelength-compatible stack/diff | **PASS** — stack refuses &lt;2 λ-matched frames; `all_detectors` labeled display-only; `/api/diff` refuses mismatched λ |
| Bug 7 centroid helper | **PASS** — `motion_windowed_centroid` + tests (Change Slider still default 1.5 px aperture) |
| Pixel inspector backend | **PASS** — `GET /api/pixel` (IMAGE + FLAGS; VARIANCE/ZODI not packed → not computed) |
| Backend tests | **PASS** — 95 |
| Frontend Vitest | **PASS** — 42 |
| Simple/Expert UI | **Deferred to Phase 5** |

## 12. Phase 5 gate (UI)

| Criterion | Status |
| --- | --- |
| Simple / Expert mode | **PASS** — `?mode=expert`; View/Analysis + inspector/Aladin/movers gated |
| Pixel inspector panel | **PASS** — click / Shift+click → `GET /api/pixel` |
| Coord validation | **PASS** — Dec ±90, RA wrap, friendly resolve errors |
| Clear preset on custom search | **PASS** (pre-existing) + Custom field chip |
| Docs `/api/pixel` | **PASS** — `docs/API.md` refreshed |
| Frontend Vitest | **PASS** — 46 |
| Playwright | **NOT RUN** |

## 13. Phase 6–7 gate (DEMO + make check)

| Criterion | Status |
| --- | --- |
| `DEMO.md` presentation script | **PASS** — Simple→Expert→scoreboard 2/3; Planet X disclaimer |
| Playwright Chromium | **PASS** — installed; 16/16 e2e |
| `make check` | **PASS** — 95 backend + 48 Vitest + build + 16 e2e |
| High-PM demo fallback | **PASS** — `manifestCenterMatch` (catalog or cutout CRVAL) after mid-span refresh |
| Blink ≤3 Hz asserted in e2e | **PASS** |

**All planned phases complete.**

## 14. Bug 7 + target-center fix

| Criterion | Status |
| --- | --- |
| Motion-windowed centroid in Change Slider | **PASS** — default `use_motion_window`; PM-predicted pixels |
| High-PM button/API centers | **PASS** — cutout CRVAL; cache accepts catalog via `manifest_center_match` |
| Barnard's assist honesty | **PASS** — UI note when PNG assist frames present |
| Regenerated `change_scores.json` | **PASS** — Barnard's fitted μ ≈ 7.7″/yr (was ~1.5; Gaia ~10.4) |

Still optional: Origin push auth, live VARIANCE/ZODI inspector, Cube SIA `TODO(VERIFY)`.
