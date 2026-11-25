# Validation methodology

## Motion-fit self-test

`pipeline/run_validation.py` and `backend/app/validate.py` inject a synthetic linear track with known proper motion and recover it with uncertainties from centroid errors. Result is labeled `is_synthetic: true`.

## Field recovery

Known high-PM targets (WISE 0855, Barnard's Star) are compared to linked detections within **2 × 6.15″** (two native SPHEREx pixels). Misses and false candidates are reported on the scoreboard.

## Synthetic injection curve

`pipeline/inject_movers.py` builds labeled synthetic movers for recovery-versus-brightness/speed tests. All synthetic products show a **SIMULATED / TEST DATA** badge in the UI.

## Honesty

SkyFlip does **not** claim to discover Planet X or any new object. Scoreboard numbers include misses by design.
