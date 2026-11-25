# Demo script (~3 minutes)

Honest pitch: SkyFlip is a SPHEREx blink comparator with the evidence shown — **candidates only**. Never claim Planet X (or any new object) was found.

## Pre-flight

- [ ] `make backend` (:8000) and `make frontend` (:5173)
- [ ] Open http://127.0.0.1:5173 — **Simple** mode, WISE 0855 by default
- [ ] Tabs visible: **Viewer**, **Validation**, **About** (Discovery only with `?labs=1`)

## Walkthrough

1. **Hook (~20 s)** — SPHEREx maps the sky in many IR bands. SkyFlip blinks real IRSA visits of one patch like a short video, with provenance (LIVE vs CACHED) on every frame.

2. **Mover (~45 s)** — Click **WISE 0855**. Read the **What am I looking at?** caption. Press **Play** (≤3 Hz). Toggle **Ghost track**. Open the **Data** panel: status pills, Observation grid, shortened archive URL with Copy/Open.

3. **Another target (~30 s)** — Click **Barnard's Star**. Same UI; ghost follows Gaia PM. Optionally type coordinates or a name — near-target snap reuses curated frames.

4. **Expert (~30 s)** — Switch to **Expert**. Open **View** → FOV presets. **Analysis** → Detect movers / spectrum. Difference and change slider stay under Advanced.

5. **Validation + About (~30 s)** — **Validation** tab: recovery hero numbers + Limits. **About**: 3-step how-to, glossary, credits. Say: **SkyFlip does not claim to discover Planet X.**

6. **Share (~15 s)** — Share → Copy share link / Copy embed code (`?embed=1`) / Cite this view.

## Offline proof

Stop the API. Click all five presets — CACHED pill, never a blank page. Free-text failure keeps prior frames + Retry banner.

## Manual QA

- [ ] Data panel FOV matches Full frame vs Target crop
- [ ] Historical positions: no-PM line for R Draconis / RW Aurigae
- [ ] Help → Replay tour; `?tour=0` skips auto-tour
- [ ] Mobile width: panels stack under the image
