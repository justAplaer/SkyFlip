# Proper-motion table (demo targets)

Authoritative machine-readable values: [`frontend/public/demo-data/pm_table.json`](../frontend/public/demo-data/pm_table.json).

This file is the **single source of truth** for manifests, ghost track, historical overlay, and validation for the five official targets. Backend: `app/pm_table.py` → `catalogs.get_proper_motion` → `SkyCoord.apply_space_motion`.

| Target | Catalog marker | PM source | Ref epoch | Notes |
| --- | --- | --- | --- | --- |
| Barnard's Star | Gaia DR3 J2016.0 | Gaia DR3 4472832130942575872 | **2016.0** ([ESA Gaia DR3 docs](https://gea.esac.esa.int/archive/documentation/GDR3/): `gaia_source.ref_epoch`) | Strongest historical arrow on D1 (~100″ from 2016→2025) |
| WISE 0855 | WISE designation / challenge coords | Luhman 2014 ApJ 786 L18 Table 1 | **~2010.5** (challenge string epoch) | Gaia DR3 N/A; CatWISE2020 row not cached (catalog epoch MJD **57170** ≈ 2015.405 per [CatWISE2020 README](https://irsa.ipac.caltech.edu/data/WISE/CatWISE/gator_docs/CatWISE2020README_IRSA.txt)) |
| Epsilon Indi B | ε Indi system @ J2016.0 | SIMBAD ε Indi A / Gaia family PM applied to B | **2016.0** | Prefer D5/D6 |
| RW Aurigae / R Draconis | none | no PM in table | — | **variable / not a high-PM mover** |

Units in JSON: **arcsec/yr**. Pixel scale: **6.15″/pix**.

## Overlay semantics

- **Cyan cross**: catalog-epoch position projected onto the fixed-sky cutout WCS.
- **Yellow circle + arrow**: PM-predicted position at the current SPHEREx MJD (`apply_space_motion` from the catalog epoch).
- Offset label: arcsec and SPHEREx pixels, with PM-error propagation when σ is known, else **no uncertainty available**.
- Missing catalogs are listed in `missing_markers` — never fabricated.
