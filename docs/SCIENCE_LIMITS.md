# Science limits and citations

## Pixel scale

- SPHEREx Spectral Image native scale: **6.15 arcsec/pixel** (Explanatory Supplement; live SIA `s_pixel_scale`).
- Older instrument page value 6.2″ is ~consistent; SkyFlip uses 6.15″.

## Level-2 IMAGE

- Units: MJy/sr.
- Zodiacal light is **not** subtracted from IMAGE (see ZODI extension).

## LVF / wavelength

- Wavelength varies across each detector. Blinking mismatched wavelengths can mimic variability.
- Prefer same detector / nearby λ when comparing epochs.

## Absorption band markers (spectrum panel)

Approximate published IR band regions used **for annotation only** (not object classification):

| Feature | Approx. µm | Notes |
| --- | --- | --- |
| H₂O | 2.7–3.5 | Broad ice/gas features in near-IR |
| CO₂ | 4.1–4.4 | Common CO₂ ice/gas region |
| CO | 4.5–4.8 | CO fundamental region |

These are standard laboratory/astronomical IR band locations for educational overlays. SkyFlip does **not** infer chemistry or object type from a cutout spectrum.

## Proper motion for WISE 0855

**Verified citation (not invented):** Luhman (2014), ApJ 786 L18 / [arXiv:1404.6501](https://arxiv.org/abs/1404.6501) Table 1:

| Quantity | Value |
| --- | --- |
| μ_α cos δ | −8.06 ± 0.09 ″/yr |
| μ_δ | +0.70 ± 0.07 ″/yr |
| π | 0.454 ± 0.045 ″ |

Challenge coordinates `08h55m10.831s, −7d14m42.53s` match the WISE designation epoch (~2010). SPHEREx DR1/QR3 visits are ~2025, so ~15 yr of motion ≈ **120″ ≈ 20 SPHEREx pixels** at 6.15″/pix. A 0.05° (180″) fixed-sky cutout centered on the 2010 position can place the object near/off the edge; SkyFlip defaults to **fixed_sky** with **FOV ≥ 0.2°** so the hop is visible, plus a **track_target** mode that recenters each epoch on the PM-propagated position via `SkyCoord.apply_space_motion`.

SkyFlip uses the Luhman 2014 values when SIMBAD PM is unavailable, always showing the citation and uncertainties.

## Proper motion for Barnard's Star

**Verified citation:** Gaia DR3 source `4472832130942575872` — μ_α* = −801.551 mas/yr, μ_δ = +10362.394 mas/yr, epoch J2016.0 (ESA Gaia / Gaia Archive; also tabulated on Wikipedia from DR3). Formal component uncertainties: see Gaia Archive (not inlined here → UI says see Gaia Archive when σ absent).

## Cross-match (Bug 5)

Each mover track is cone-searched against SIMBAD (timeouts/retries) with radius from position uncertainty and PM×span (default floor ≈ 2 SPHEREx pixels). Offline demo uses `frontend/public/demo-data/crossmatch_cache.json` (`status=cached`). Outcomes: `matched`/`cached` → classification **known** (catalogued reference shown); `no_match` → **unverified candidate**; `unavailable` → **candidate (not cross-matched)** — never “known” or “new/discovery”.

## IMAGE vs ZODI (verified 2026-11-14)

Per [IRSA Data Products](https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-products/): Spectral Image **IMAGE** is calibrated MJy/sr **without** zodiacal subtraction; **ZODI** is a separate model layer. Subtracting ZODI for display must be labeled as such. The DR1 **All-Sky Cube** already has ZODI subtracted and is a coadd — usable for spectra only, not motion.

## FLAGS: SOURCE is informational

Explanatory Supplement Table 16 bit 21 (`SOURCE`) marks pixels associated with a known source. SkyFlip does **not** mask SOURCE (or FULLSAMPLE) as bad. High flagged fractions on Barnard's / R Dra cutouts are often SOURCE-dominated — investigate before claiming the frame is unusable.

## Barnard's Star cutout centering (Phase 3, 2026-11-14)

**Root cause (verified in manifests):** `fixed_sky` cutouts used Gaia DR3 **J2016.0** RA/Dec as IBE `center=`. By SPHEREx epoch (~2025.6) the star is ~100″ (~16 SPHEREx pixels) away → edge truncation (96×117) and median peak S/N≈0.67 at the predicted pixel.

**Fix:** `catalogs.fixed_sky_cutout_center` — for significant PM, set one shared CRVAL to `apply_space_motion(catalog → mid-span SPHEREx MJD)`. Movers still hop on a fixed grid; historical overlay shows the Gaia cross off-center. Variables (μ≈0) keep catalog center.

**Re-cache:** mid-span CRVAL (~269.450°, +4.723°) is required. After recenter, live IBE checks show the **IMAGE core at the PM position is still ~background** while FLAGS mark `SOURCE`/`HALO` there — consistent with SPHEREx L2 blanking early-OVERFLOW cores for the brightest stars (Explanatory Supplement / bright-star bloom notes). A nearby saturated field star (~165″ away) is *not* Barnard's (stationary on the sky).

**Display fix:** when aperture S/N&lt;3 but HALO/SOURCE flags sit near the PM prediction, precache writes a **labeled PNG display assist** (FLAGS accent + soft Gaussian at the predicted pixel). Float `_image.bin` stays unaltered archive IMAGE. Scoreboard method strings disclose assist frames. Do not treat the stamp as photometric proof of flux.

## Bug 7 — motion-windowed centroid (wired)

Change Slider photometry stays on a fixed **1.5 px** aperture. **Centroids** use `motion_windowed_centroid`: half-width = `max(2.0, expected_hop_pix + 1.5)` centered on each frame’s PM-predicted pixel (`predicted_x_pix` / `predicted_y_pix` from the demo pack). Notes include `centroid_window_half_pix=…`.

Barnard's IMAGE core is often saturation-blanked (S/N≪3) — the wider window cannot invent flux. Reported μ keeps measured ±σ (never replaced by Gaia). PNG display-assist stamps are labeled; float `.bin` stays archive IMAGE.

## Variable ≠ mover (Phase 4)

RW Aurigae and R Draconis are **variable controls** (`pm_table.classification_note`), not high-PM movers. Scoreboard `recovery_rate` counts only `role=known_mover` (WISE 0855, Barnard's, ε Indi B). Variables stay in a separate `variable_controls` block.

## Detector defaults for demo targets

Band ranges from SPHEREx Data Products / Explanatory Supplement (`docs/DATA_NOTES.md`):

| Detector | λ (µm) | Default for |
| --- | --- | --- |
| D1 | 0.75–1.09 | Barnard's Star, RW Aur, R Dra |
| D5 | 3.83–4.41 | WISE 0855, Epsilon Indi B (cold / red) |
| D6 | 4.42–5.00 | alternate for cold brown dwarfs |

WISE 0855 peaks near Spitzer [4.5]; prefer **D5/D6** (Data Products bands 5–6). Measured offline (FOV 0.2°, 8 frames, SIA/IBE, 2026-11-14 re-precache) at the Luhman-propagated pixel:

| Detector | Median peak S/N | Detectable (S/N≥3)? | Predicted hop first→last |
| --- | --- | --- | --- |
| D5 (default) | ≈5.0 | yes | ≈1.34 px (≈8.3″) |
| D6 | ≈3.2 | yes | ≈1.33 px |
| D1 (comparison) | ≈5.9 | aperture yes* | ≈1.31 px |

\*D1 aperture S/N is **not** treated as a confirmation of the Y dwarf on 0.75–1.09 µm — cold SED flux should be negligible there; high D1 values are consistent with confusion/background in the 1.5 px aperture. Demo default and API `DEFAULT_DETECTOR_BY_TARGET` stay **SPHEREx-D5**. Challenge coordinates epoch ≈**2010.5** (WISE designation / Luhman 2014); see Proper motion section above. Machine-readable: `frontend/public/demo-data/visibility_report.json`.

## Change score (Change Slider)

**Language:** A high score means “this frame differs from the reference at this position,” **not** “a new object” or a discovery. UI and API treat hits as **candidates only**.

### Aperture

- Default radius ≈ **1.5 SPHEREx pixels** (~9.2″ at 6.15″/pix) — within the stated 1–2 pixel guidance.
- Local annulus background: inner/outer ≈ 2.5 / 4.0 pixels (median residual).
- Bad FLAGS bits (transient, overflow, ghost, halo, …) and non-finite pixels are masked; informational bits `SOURCE` / `FULLSAMPLE` are kept. The API reports `n_masked` / `masked_fraction`.
- **Saturated cores (Bug 2):** Explanatory Supplement Table 16 — bit **1 `OVERFLOW`** (“Overflow / saturation threshold during SUR”), bit **26 `BLOOM`** (“Source blooming”). When the aperture is fully masked by these, SkyFlip tries (1) ring photometry outside the masked core, then (2) a relaxed mask that ignores only OVERFLOW/BLOOM. Both paths set `approximate=True` with an “approximate (saturated core)” badge and are never mixed unmarked with exact scores. If both fail: `not computed: source saturated` with masked pixel counts (not an empty slider).

### Reference (selectable)

| Mode | Definition |
| --- | --- |
| `median_others` (default) | Nan-median of **wavelength-matched** peer frames on the common WCS grid. If no peers within tolerance, the frame is **excluded** (`wavelength_mismatched=True`, status=`not_computed`) — no silent fallback to colour-mismatched peers. |
| `first_epoch` | Frame 0 image; `|Δλ|` vs frame 0 is checked. |
| `previous_epoch` | Prior frame in time order (self for epoch 0); `|Δλ|` vs previous is checked. |

**Default wavelength tolerance:** `±0.03 µm` (`DEFAULT_WAVELENGTH_TOL_UM`), ≈ one D1 spectral resolution element at ~1.1 µm (Data Products Band 1 R≈39 → Δλ≈λ/R≈0.028 µm) and ≈ the LVF gradient across a typical 0.2° cutout. Configurable via API/`wavelength_tol_um` and shown in the Change Slider UI. The old ±0.15 µm default was nearly half of D1’s 0.34 µm band and let colour differences rank as “change.”

LVF wavelength variation across a detector can mimic variability. **All three reference modes** set `wavelength_mismatched` and `wavelength_diff_um` honestly. Mismatched frames are excluded from ranking (visible “wavelength-mismatched” badge); if fewer than two matched frames remain, the API reports `too few wavelength-matched frames` instead of a motion score.

### Brightness change (S/N)

\[
\mathrm{SNR} = \frac{\sum_{\mathrm{ap}} (I - R - B_{\mathrm{ann}})}{\sqrt{\sum_{\mathrm{ap}} 2\,\sigma^2}}
\]

- \(I\): frame IMAGE; \(R\): reference; \(B_{\mathrm{ann}}\): median residual in the annulus.
- \(\sigma^2\): VARIANCE extension. Factor 2 approximates variance of (frame − median stack) when per-peer variances are not co-added. If VARIANCE is missing, annulus scatter is used and the note says so — **never invent a number**.
- Score uncertainty reported as ≈ 1 (Gaussian S/N scale) when variance-based; UI always shows uncertainty or “no uncertainty available”.
- If the aperture is empty / all masked / non-positive σ → `status=not_computed`, `score=null`.

### Position shift

- Flux-weighted centroid in the aperture vs reference centroid.
- Reported in **pixels** and **arcsec** (`× 6.15″`), with centroid σ propagated.
- Metric `position_shift` displays arcsec offset; `combined` uses \(\mathrm{hypot}(|\mathrm{SNR}_{\mathrm{bright}}|, |\mathrm{shift}/\sigma_{\mathrm{shift}}|)\).

### Apparent motion from trail

- Needs **≥ 3** frames with centroids; otherwise: “too few points to estimate motion”.
- Total displacement and rate (″ and ″/yr) from first→last epoch using **real MJDs**, with endpoint centroid uncertainties.

## Community observation reports

- A user report is an **unverified community observation**, not a detection and not a discovery.
- Reported “up/left” directions depend on **display orientation**; always store north/east from WCS and prefer sky-based position angle for science use.
- LVF **wavelength mismatch** between frames can look like brightness change — reports should note detector/λ; do not treat λ-mismatched blinks as pure motion.
