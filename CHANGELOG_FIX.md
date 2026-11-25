# CHANGELOG_FIX — full-frame viewer, sliders, demo cleanup

## Revert images / frame choice only — 2026-11-14

Restored demo packs from commit **`f9919f9`**
(`Add full-frame tiled viewer with working toolbar and box-zoom.`) — the state
after the full-frame controls / box-zoom task, before the distinct-frames work:

- `frontend/public/demo-data/**` (exact tree from `f9919f9`; no orphan bins)

(Earlier mistaken restore from `1aa3c17` was replaced.)

`pipeline/precache_targets.py` and `_select_blink_epochs` were **unchanged** by the
distinct-frames work (nothing to check out).

Also removed the distinct-frames **prefer-demo-first** path in `App.tsx` so cutouts
are live-first again, with demo only as offline fallback.

**Kept:** full-frame viewer, tiling, Box zoom, toolbar, SliderWithInput, detector
reset / load abort, blink Play+speed preload, Gaia overlay, Simple/Expert, source
badge, demo `view_mode=target_crop` adapter, and existing tests.

---

## Root cause (same image on all 5 targets / blink frozen) — 2026-11-14

Demo packs under `frontend/public/demo-data/*` are **already distinct** (0 shared
`obs_id`s). The UI still looked identical because:

1. **Sticky detector** — after WISE 0855 / ε Indi B, `detector` stayed at **5**, so
   Barnard's / RW Aur / R Dra requested D5 instead of D1 and got the wrong field.
2. **No request sequencing** — `loadField` had no AbortController / generation token,
   so a slow earlier target could overwrite a newer click.
3. **Default full-frame fit** — `viewMode=full_frame` at ~0.3× shows five similar
   2040² detector planes; motion is invisible until “Go to target”.
4. **Demo fallback kept `view_mode=full_frame`** while serving crop PNGs → FullFrameStage
   with no tiles → same “Loading…” for every button.
5. **Pyramid `target_xy` not refreshed** when meta was already on disk for another RA/Dec.
6. **FullFrameStage Play starts off** and did not zoom to the target on field change.

**Fix:** reset detector per target; abort stale loads; prefer cached demo for presets
in target-crop; force `view_mode=target_crop` on demo responses; recompute `target_xy`;
auto go-to-target + gated Play/preload; `data-obs-id` + distinct-list tests.

---

## Root cause (broken full-frame toolbar) — 2026-11-14

Buttons updated React state, but the tiled renderer did not reliably redraw from that
state:

1. **Async paint race** — `paint()` cleared the canvas, then `await`ed tiles while
   calling `setLoadNote` mid-draw, so concurrent paints stomped each other and
   clicks looked like no-ops.
2. **Frames-identity reset** — a `useEffect([frames, …])` reset index/scale whenever
   the parent passed a new array reference (e.g. after change-scores / keptEpochIds),
   wiping zoom and Step progress.
3. **No single view source of truth** — scale / sky center lived only in React state
   without a dirty/rAF loop, so wheel, buttons, and slider could diverge from what
   was on screen.

**Fix:** one `{ centerRa, centerDec, scale }` view (refs + state), `requestAnimationFrame`
+ dirty flag, reset only when the epoch-id signature / zodi / field changes, and
Box-zoom / Back / tool switcher. See `FullFrameStage.tsx`, `lib/fullFrameView.ts`,
`e2e/viewer-controls.spec.ts`.

**Follow-up:** inline `onMeta={(m,s)=>…}` in `App.tsx` recreated every render and
retriggered FullFrameStage’s meta effect → “Maximum update depth exceeded”. Fixed with
`useCallback` + `onMetaRef` so the draw loop stays stable.

---

Acceptance items from the demo fix task. Status as of this write.

## Part 1 — Backend full frame

| Item | Status | Note |
| --- | --- | --- |
| `fetch_full_frame` (bare IBE URL, not cutout) | **Done** | `SpherexAdapter.fetch_full_frame`; cutout kept as fallback |
| `subtract_zodi` query default **false** | **Done** | `/api/cutouts` + pyramid keyed by zodi0/zodi1 |
| Pyramid tiles 256² + levels 0…N | **Done** | `backend/app/frame_pyramid.py` + disk cache under `.cache/frames/` |
| `GET /api/frame/.../meta\|tile\|flags` | **Done** | |
| `/api/epochs-full` + `target_xy` | **Done** | Also on `/api/cutouts?view_mode=full_frame` |
| Offline overview 1024 + crop 600 packs | **Not done** | Demo packs remain target-crop float bins; labeled Cached. Full-frame offline needs a live precache pass (`view_mode=full_frame`) that was not re-run against IRSA in this session |
| Re-precache raw IMAGE (no ZODI) | **Partial** | Precache already used `subtract_zodi=False`; manifests stamped; orphan PNG/bin deleted; `index.json` regenerated from manifests |
| Orphan cleanup | **Done** | 39 unreferenced `.png`/`.bin` removed |

## Part 2 — Frontend tiled viewer

| Item | Status | Note |
| --- | --- | --- |
| Tiled FullFrameStage | **Done** | `FullFrameStage.tsx` + `tileCache.ts` + `wcsSky.ts` |
| Shared stretch across blink frames | **Done** | From first frame robust stats (p01–p995) |
| Zoom/pan/fit/go-to-target/1:1 | **Done** | Wheel, drag, double-click, typed zoom |
| Sky-aligned blink + outside detector | **Done** | WCS center held; message when patch out of frame |
| Pixel axes + scale bar + ghost via WCS | **Partial** | Axes ticks + scale bar + target/ghost markers; cursor MJy/sr readout not fully wired |
| Data panel: URL, shape, zodi, stretch | **Done** | `MetadataPanel` extended |
| ZODI + Full frame / Target crop toggles | **Done** | |
| Coarse-first &lt;3s + progress | **Partial** | Progress note shown; cold IRSA full MEF still dominates first load |

## Part 3 — SliderWithInput

| Item | Status | Note |
| --- | --- | --- |
| Reusable `SliderWithInput` | **Done** | Clamp, snap, arrows, invalid restore, a11y |
| Blink speed / zoom / clip lo/hi | **Done** | In `BlinkPlayer` + `FullFrameStage` |
| Report confidence | **Done** | |
| Change-slider dual range | **Not done** | Already had number boxes; left as-is |
| Share URL zoom/stretch/epoch | **Partial** | Existing urlState covers stretch/clip/zoom rect; full-frame sky center not yet in share URL |

## Part 4 — Fixes / cleanup

| Item | Status | Note |
| --- | --- | --- |
| Slim toolbar + Advanced panel | **Done** | Change slider / diff under Advanced |
| `?demo=1` WISE 0855 guide | **Done** | Step walkthrough in Viewer |
| Split BlinkPlayer / App giants | **Not done** | Added modules alongside; did not finish a full extract of the 1.4k-line BlinkPlayer |
| `scripts/check_live.py` + `LIVE_CHECK.md` | **Done** | |
| Honest claims review | **Partial** | No new Planet X claims; scoreboard still produced by `run_validation` — not re-audited line-by-line this pass |
| classify significance + ≥3 epochs | **Done** | Already significance-based; added ≥3-epoch gate |
| detect single-weight fit | **Done** | Normal equations with 1/σ² once + unit test |
| No WISE 0855 hardcoded PM outside pm_table | **Done** | Name-heuristic literature fallbacks removed from `get_proper_motion` |
| Pin Aladin Lite | **Done** | Already pinned to v3.4.0, lazy load |
| Reset index on frame change | **Done** | FullFrameStage resets; BlinkPlayer prior behavior kept |
| `demo-data/index.json` from manifests | **Done** | |

## Tests / build

| Check | Status |
| --- | --- |
| `pytest` | **106 passed** |
| `npm test` (vitest) | **63 passed** |
| `npm run build` | **Passed** |

## Honesty reminder

SkyFlip does **not** claim to discover Planet X. Full-frame pixels come from archive IMAGE; offline mode is always labeled **Cached**.

---

# Usability redesign (scientists + hobbyists) — 2026-11-14

## Part A — Data + Historical panels

| Item | Status | Note |
| --- | --- | --- |
| Status pills (LIVE/CACHED, view, ZODI, detector) | **Done** | Green live / amber cached |
| Two-column meta grid + collapsible sections | **Done** | Observation open by default; localStorage |
| Shortened archive URL + Copy/Open | **Done** | Full URL on hover / clipboard |
| Correct FOV for full frame vs crop | **Done** | Shape × 6.15″; plain pixel/background wording |
| Verified badge | **Done** | |
| Flag chips + Show flagged sync | **Done** | Synced with blink `showFlags` |
| Historical legend, PM table, no-PM line | **Done** | `HistoricalPositionsPanel` |
| Catalog cards; hide empty noise | **Done** | |

## Part B — Navigation / Validation / About

| Item | Status | Note |
| --- | --- | --- |
| Discovery out of main nav | **Done** | Kept behind `?labs=1` |
| Scoreboard → Validation, one-screen hero | **Done** | Detail in `<details>`; Limits trimmed to 4 bullets |
| About tab | **Done** | SPHEREx, 3 steps, glossary, credits, Planet X sentence |
| Tab labels Viewer / Validation / About | **Done** | |

## Part C — Challenge features

| Item | Status | Note |
| --- | --- | --- |
| URL state + embed | **Done** | Existing urlState; Share → Copy embed code |
| Cite this view | **Done** | Share menu |
| FOV presets + size note | **Done** | Expert → View |
| Diff / stack / 102-band spectrum / Gaia overlay | **Partial** | Existing Expert Analysis + Spectrum + Aladin kept; no new stack UI this pass (avoid breaking working blink) |
| `docs/ADDING_DATA.md` + `make refresh` | **Done** | Alias to `refresh-data` |
| Coordinates + fail banner | **Done** | Prior coord task; kept |

## Part D — Hobbyist

| Item | Status | Note |
| --- | --- | --- |
| First-run tour + Help | **Done** | Skipped when `demo=1` / `embed=1` / `tour=0` |
| Glossary in About | **Done** | |
| Simple / Expert | **Done** | Pre-existing; captions always for 5 targets |
| Target captions | **Done** | From `pm_table` citations only |
| Photosensitivity note | **Done** | Footer |

## Part E — Scientist

| Item | Status | Note |
| --- | --- | --- |
| Export FITS/PNG/CSV/repro JSON | **Not done** | Candidates JSON + cite kept; full FITS/PNG/CSV export deferred to avoid breaking viewer |
| Candidate honesty text | **Done** | Strengthened disclaimer |
| Alignment proof in Data panel | **Partial** | Prop wired; live Gaia median offset not computed this pass |
| Pin deps / version in footer | **Done** | App v0.2.0 + IRSA release note |

## Part F — Polish

| Item | Status | Note |
| --- | --- | --- |
| Source badge always | **Done** | Data pills |
| README / DEMO | **Partial** | DEMO.md rewritten to match tabs; README already has quick start |
| Dead-code purge / split 500-line files | **Not done** | Explicitly avoided large deletions (“don’t change other features”) |
| Screenshots of all tabs | **Not done** | Playwright green; manual screenshots not captured in this agent pass |

## Tests

| Check | Status |
| --- | --- |
| `npm run build` | **Passed** |
| `npm test` | **87 passed** |
| `pytest` | **112 passed** |
| Playwright (coords + bug1 + ui-polish) | **Passed** (after tour/`demo` fix) |

SkyFlip does **not** claim to discover Planet X.
