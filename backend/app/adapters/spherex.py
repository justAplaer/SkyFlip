"""
SPHEREx / IRSA data adapter.

ALL live SPHEREx I/O belongs here. Endpoints, MEF layout, and flag bits are
taken from verified IRSA documentation — see docs/DATA_NOTES.md.
Do not invent FITS extension names or API paths.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import urlencode

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from astropy.utils.data import conf as astropy_data_conf

# IRSA cutouts can exceed the default remote timeout.
astropy_data_conf.remote_timeout = 180

logger = logging.getLogger(__name__)


class SpherexAdapterError(RuntimeError):
    pass


def _curl_get_bytes(url: str, *, timeout: float = 30.0) -> bytes:
    """Fetch via curl --noproxy (requests often stalls/502s on IRSA in this env)."""
    cmd = [
        "curl",
        "-fsSL",
        "--noproxy",
        "*",
        "--http1.1",
        "--max-time",
        str(max(1, int(timeout))),
        "--retry",
        "0",
        "--retry-delay",
        "2",
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False, timeout=timeout + 5)
    except FileNotFoundError as exc:
        raise SpherexAdapterError("curl not found on PATH") from exc
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")[:300]
        raise SpherexAdapterError(f"curl failed ({proc.returncode}) for {url}: {err}")
    if len(proc.stdout) < 10:
        raise SpherexAdapterError(f"curl empty body for {url}")
    return proc.stdout


def _curl_download(url: str, path: Path, *, timeout: float = 30.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    cmd = [
        "curl",
        "-fsSL",
        "--noproxy",
        "*",
        "--http1.1",
        "--max-time",
        str(max(1, int(timeout))),
        "--retry",
        "0",
        "--retry-delay",
        "3",
        "-o",
        str(tmp),
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False, timeout=timeout + 5)
    if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1000:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")[:300]
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise SpherexAdapterError(f"curl download failed for {url}: {err}")
    tmp.replace(path)

IRSA_TAP_SYNC = "https://irsa.ipac.caltech.edu/TAP/sync"
IRSA_SIA = "https://irsa.ipac.caltech.edu/SIA"
IRSA_BASE = "https://irsa.ipac.caltech.edu/"

# Verified SIA2 collections (IRSA Data Access, 2026-11-12).
# SkyFlip always searches these four — DR1/QR3 wide + deep.
SIA_COLLECTIONS = (
    "spherex_dr1",
    "spherex_dr1_deep",
    "spherex_qr3",
    "spherex_qr3_deep",
)
SIA_COLLECTIONS_WIDE = ("spherex_dr1", "spherex_qr3")
SIA_COLLECTIONS_DEEP = ("spherex_dr1_deep", "spherex_qr3_deep")

# Verified bandpass names in TAP/SIA.
BANDPASSES = tuple(f"SPHEREx-D{i}" for i in range(1, 7))

# Pixel scale from Explanatory Supplement / live SIA s_pixel_scale.
PIXEL_SCALE_ARCSEC = 6.15

# FLAGS bit names from Explanatory Supplement Table 16 / IRSA intro notebook.
# Values are bit indices (flag value = 1 << bit).
FLAG_BITS: dict[str, int] = {
    "TRANSIENT": 0,
    "OVERFLOW": 1,
    "SUR_ERROR": 2,
    "NONFUNC": 6,
    "DICHROIC": 7,
    "MISSING_DATA": 9,
    "HOT": 10,
    "COLD": 11,
    "FULLSAMPLE": 12,
    "PHANMISS": 14,
    "NONLINEAR": 15,
    "PERSIST": 17,
    "OUTLIER": 19,
    "SOURCE": 21,
    "GHOST": 22,
    "GHOST_FPA": 23,  # listed in IRSA intro notebook
    "GHOST_EXT": 24,
    "STREAK": 25,  # listed in IRSA intro notebook
    "BLOOM": 26,
    "SNOWBALL": 27,
    "HALO": 28,
    "SATELLITE_HALO": 29,
}

DEFAULT_CACHE_DIR = Path(
    os.environ.get(
        "SKYFLIP_CACHE_DIR",
        Path(__file__).resolve().parents[3] / ".cache",
    )
)


@dataclass
class SpherexObservation:
    """One Spectral Image covering a position (one detector / bandpass)."""

    obs_id: str
    bandpass: str
    detector: int
    mjd: float
    access_url: str
    cutout_url: str
    collection: str = ""
    time_iso: str = ""
    s_pixel_scale_arcsec: Optional[float] = None
    source: str = "live"

    def to_dict(self) -> dict[str, Any]:
        return {
            "obs_id": self.obs_id,
            "bandpass": self.bandpass,
            "detector": self.detector,
            "mjd": self.mjd,
            "time_iso": self.time_iso,
            "access_url": self.access_url,
            "cutout_url": self.cutout_url,
            "collection": self.collection,
            "s_pixel_scale_arcsec": self.s_pixel_scale_arcsec,
            "source": self.source,
        }


@dataclass
class SpherexCutout:
    """Parsed cutout MEF for one observation."""

    observation: SpherexObservation
    image: np.ndarray
    flags: np.ndarray
    variance: Optional[np.ndarray]
    zodi: Optional[np.ndarray]
    wcs: WCS
    central_wavelength_um: Optional[float]
    bandwidth_um: Optional[float]
    header_meta: dict[str, Any] = field(default_factory=dict)
    flag_summary: dict[str, int] = field(default_factory=dict)
    fits_path: Optional[Path] = None
    source: str = "live"


def _detector_from_bandpass(bandpass: str) -> int:
    m = re.search(r"D([1-6])$", bandpass or "")
    if not m:
        raise SpherexAdapterError(f"Unrecognized bandpass: {bandpass!r}")
    return int(m.group(1))


def _mjd_to_iso(mjd: float) -> str:
    try:
        return Time(mjd, format="mjd", scale="utc").isot
    except Exception:
        return ""


def build_cutout_url(access_url: str, ra: float, dec: float, size_deg: float) -> str:
    """Append IBE cutout query string (verified IRSA cutout docs)."""
    base = access_url.split("?")[0]
    # Official notebook uses center=ra,dec d&size=...
    qs = urlencode({"center": f"{ra},{dec}d", "size": f"{size_deg}"})
    return f"{base}?{qs}"


def summarize_flags(flags: np.ndarray) -> dict[str, int]:
    """Count pixels with each named flag bit set."""
    arr = np.asarray(flags)
    out: dict[str, int] = {}
    for name, bit in FLAG_BITS.items():
        mask = (arr.astype(np.uint64) & (1 << bit)) != 0
        out[name] = int(np.count_nonzero(mask))
    out["any_flagged"] = int(np.count_nonzero(arr != 0))
    out["total_pixels"] = int(arr.size)
    return out


class SpherexAdapter:
    """Single module for SPHEREx discovery + cutout fetch + MEF parse."""

    def __init__(
        self,
        cache_dir: Path | str | None = None,
        session: requests.Session | None = None,
        timeout: float = 30.0,
        include_deep: bool = True,
        collections: tuple[str, ...] | None = None,
    ) -> None:
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        if session is not None:
            self.session = session
        else:
            self.session = requests.Session()
            # Ignore HTTP(S)_PROXY — Cursor/sandbox proxies often 502 IRSA.
            self.session.trust_env = False
            self.session.proxies = {"http": None, "https": None}
        self.timeout = float(os.environ.get("SKYFLIP_HTTP_TIMEOUT", str(timeout)))
        self.include_deep = include_deep
        # Default: all four official IRSA SIA collections.
        self.collections = collections or SIA_COLLECTIONS

    # ------------------------------------------------------------------ health
    def ping_irsa(self) -> dict[str, Any]:
        """Lightweight connectivity check against IRSA SIA (no TAP)."""
        try:
            params = {
                "COLLECTION": "spherex_dr1",
                "POS": "circle 133.79512917 -7.24514722 0.05",
                "RESPONSEFORMAT": "csv",
            }
            url = f"{IRSA_SIA}?{urlencode(params)}"
            body = _curl_get_bytes(url, timeout=min(60.0, self.timeout)).decode(
                "utf-8", errors="replace"
            )
            ok = "access_url" in body
            return {
                "ok": ok,
                "status_code": 200 if ok else 0,
                "endpoint": IRSA_SIA,
                "mode": "sia+curl",
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc), "endpoint": IRSA_SIA, "mode": "sia+curl"}

    # --------------------------------------------------------------- discovery
    def find_observations(
        self,
        ra: float,
        dec: float,
        *,
        fov_deg: float = 0.15,
        bandpasses: Iterable[str] | None = None,
        max_rows: int = 500,
        prefer: str = "sia",
    ) -> list[SpherexObservation]:
        """
        Find Spectral Images covering (ra, dec).

        SkyFlip policy: SIA/IBE-first only (spherex_dr1, spherex_dr1_deep,
        spherex_qr3, spherex_qr3_deep). TAP is skipped — do not fall back to TAP.
        """
        bands = tuple(bandpasses) if bandpasses else BANDPASSES
        # Discovery POS radius stays small — SPHEREx Spectral Images are ~3.5° wide,
        # so a 0.05–0.08° cone still finds covering MEFs. Cutout size = fov_deg separately.
        # Large POS (e.g. 0.2°) makes SIA return huge CSVs that stall.
        search_radius = 0.06

        if prefer not in ("sia", "sia_only"):
            logger.warning(
                "prefer=%r ignored — SkyFlip uses SIA/IBE only (TAP skipped)", prefer
            )

        obs = self._find_via_sia(
            ra,
            dec,
            radius_deg=search_radius,
            cutout_size_deg=fov_deg,
            bandpasses=bands,
        )
        if not obs:
            raise SpherexAdapterError(
                f"SIA returned no covering Spectral Images at "
                f"ra={ra}, dec={dec}, fov={fov_deg}, bands={bands}"
            )
        return obs[:max_rows]

    def _find_via_tap(
        self,
        ra: float,
        dec: float,
        *,
        fov_deg: float,
        bandpasses: tuple[str, ...],
        max_rows: int,
    ) -> list[SpherexObservation]:
        # energy_bandpassname IN (...) — verified names SPHEREx-D1..D6
        band_list = ", ".join(f"'{b}'" for b in bandpasses)
        query = f"""
SELECT TOP {int(max_rows)}
  'https://irsa.ipac.caltech.edu/' || a.uri AS access_url,
  'https://irsa.ipac.caltech.edu/' || a.uri
    || '?center={ra},{dec}d&size={fov_deg}' AS cutout_url,
  p.time_bounds_lower AS mjd,
  p.energy_bandpassname AS bandpass,
  a.uri AS uri
FROM spherex.artifact a
JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
  AND p.energy_bandpassname IN ({band_list})
ORDER BY p.time_bounds_lower
""".strip()

        table = self._tap_csv(query)
        out: list[SpherexObservation] = []
        for row in table:
            bandpass = row.get("bandpass") or row.get("energy_bandpassname") or ""
            access = row["access_url"].strip().strip('"')
            cutout = row.get("cutout_url", "").strip().strip('"') or build_cutout_url(
                access, ra, dec, fov_deg
            )
            mjd = float(row["mjd"])
            uri = row.get("uri", "")
            obs_id = self._obs_id_from_uri(uri) or Path(access.split("?")[0]).stem
            detector = _detector_from_bandpass(bandpass)
            out.append(
                SpherexObservation(
                    obs_id=obs_id,
                    bandpass=bandpass,
                    detector=detector,
                    mjd=mjd,
                    access_url=access,
                    cutout_url=cutout,
                    collection=self._collection_from_uri(uri or access),
                    time_iso=_mjd_to_iso(mjd),
                    s_pixel_scale_arcsec=PIXEL_SCALE_ARCSEC,
                    source="live",
                )
            )
        return out

    def _find_via_sia(
        self,
        ra: float,
        dec: float,
        *,
        radius_deg: float,
        bandpasses: tuple[str, ...],
        cutout_size_deg: float | None = None,
    ) -> list[SpherexObservation]:
        collections = list(self.collections)
        if not self.include_deep:
            collections = [c for c in collections if c in SIA_COLLECTIONS_WIDE]

        size = cutout_size_deg if cutout_size_deg is not None else radius_deg
        band_set = set(bandpasses)
        out: list[SpherexObservation] = []
        seen_urls: set[str] = set()
        import time

        from ..cache import cache_root, read_json, write_json

        for collection in collections:
            params = {
                "COLLECTION": collection,
                "POS": f"circle {ra} {dec} {radius_deg}",
                "RESPONSEFORMAT": "csv",
            }
            logger.info("SIA query COLLECTION=%s POS=circle %s %s %s", collection, ra, dec, radius_deg)
            rows: list[dict[str, str]] = []
            last_err: Exception | None = None
            sia_url = f"{IRSA_SIA}?{urlencode(params)}"
            # Disk cache keyed by (ra, dec, radius, collection)
            cache_key = (
                f"sia_{collection}_{ra:.5f}_{dec:.5f}_{radius_deg:.5f}.json"
            )
            cache_path = cache_root() / "sia" / cache_key
            if cache_path.exists():
                try:
                    cached = read_json(cache_path)
                    if isinstance(cached, list) and cached:
                        rows = cached
                        logger.info("SIA cache hit %s (%s rows)", cache_key, len(rows))
                except Exception as exc:
                    logger.warning("SIA cache read failed: %s", exc)
            if not rows:
                for attempt in range(1, 2):
                    try:
                        text = _curl_get_bytes(
                            sia_url, timeout=self.timeout
                        ).decode("utf-8", errors="replace")
                        if text.lstrip().startswith("<"):
                            raise SpherexAdapterError(
                                f"SIA returned HTML/error for {collection}: {text[:200]}"
                            )
                        rows = self._parse_csv(text)
                        last_err = None
                        try:
                            write_json(cache_path, rows)
                        except Exception as wexc:
                            logger.warning("SIA cache write failed: %s", wexc)
                        break
                    except (SpherexAdapterError, ValueError, OSError) as exc:
                        last_err = exc
                        logger.warning(
                            "SIA %s attempt %s failed: %s", collection, attempt, exc
                        )
                        time.sleep(0)
            if last_err is not None and not rows:
                logger.warning("Skipping SIA collection %s after retries: %s", collection, last_err)
                continue
            for row in rows:
                bandpass = row.get("energy_bandpassname", "")
                if band_set and bandpass not in band_set:
                    continue
                access = row["access_url"].strip().strip('"')
                if "/ibe/data/" not in access:
                    # Only IBE URLs support the verified cutout query string.
                    continue
                if access in seen_urls:
                    continue
                seen_urls.add(access)
                mjd = float(row.get("t_min") or 0.0)
                scale = row.get("s_pixel_scale")
                out.append(
                    SpherexObservation(
                        obs_id=row.get("obs_id", Path(access).stem),
                        bandpass=bandpass,
                        detector=_detector_from_bandpass(bandpass),
                        mjd=mjd,
                        access_url=access,
                        cutout_url=build_cutout_url(access, ra, dec, size),
                        collection=row.get("obs_collection") or collection,
                        time_iso=_mjd_to_iso(mjd),
                        s_pixel_scale_arcsec=float(scale) if scale else PIXEL_SCALE_ARCSEC,
                        source="live",
                    )
                )
        out.sort(key=lambda o: (o.mjd, o.detector))
        return out

    # ------------------------------------------------------------ full frames
    def full_frame_url(self, observation: SpherexObservation) -> str:
        """Archive Level-2 Spectral Image MEF URL (no IBE cutout query)."""
        return observation.access_url.split("?")[0]

    def fetch_full_frame(
        self,
        observation: SpherexObservation,
        *,
        force: bool = False,
        subtract_zodi: bool = False,
        target_ra: float | None = None,
        target_dec: float | None = None,
        allow_cutout_fallback: bool = True,
    ) -> SpherexCutout:
        """Download (or cache-hit) the FULL detector IMAGE MEF and parse extensions.

        Uses the bare IBE access_url — not a center/size cutout. Cutouts remain
        available via fetch_cutout as a fallback when the full file is unavailable
        and allow_cutout_fallback is True. Pyramid builders should pass False so a
        failed download never permanently caches a 0.5° crop as "full frame".
        """
        url = self.full_frame_url(observation)
        path = self._full_frame_cache_path(url)
        if force or not path.exists():
            try:
                self._download(url, path)
            except SpherexAdapterError:
                if not allow_cutout_fallback:
                    raise
                logger.warning(
                    "full-frame download failed for %s; falling back to cutout",
                    observation.obs_id,
                )
                return self.fetch_cutout(
                    observation,
                    force=force,
                    subtract_zodi=subtract_zodi,
                    center_ra=target_ra,
                    center_dec=target_dec,
                    size_deg=0.5,
                )
        return self.parse_cutout_fits(
            path,
            observation,
            subtract_zodi=subtract_zodi,
            target_ra=target_ra,
            target_dec=target_dec,
        )

    def _full_frame_cache_path(self, url: str) -> Path:
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
        stem = Path(url.split("?")[0]).stem
        return self.cache_dir / "full_frames" / f"{stem}_{digest}.fits"

    # ----------------------------------------------------------------- cutouts
    def fetch_cutout(
        self,
        observation: SpherexObservation,
        *,
        force: bool = False,
        subtract_zodi: bool = False,
        center_ra: float | None = None,
        center_dec: float | None = None,
        size_deg: float | None = None,
    ) -> SpherexCutout:
        """Download (or cache-hit) a cutout MEF and parse IMAGE/FLAGS/VARIANCE/ZODI/WCS-WAVE.

        Optional center_ra/center_dec rebuild the IBE cutout URL for track-target mode
        (epoch-aware centering) without changing the parent exposure selection.
        """
        url = observation.cutout_url
        if center_ra is not None and center_dec is not None:
            size = size_deg if size_deg is not None else 0.15
            # Strip any existing query and rebuild with the requested center.
            base = observation.access_url.split("?")[0]
            url = build_cutout_url(base, center_ra, center_dec, size)
        path = self._cache_path(url)
        if force or not path.exists():
            self._download(url, path)

        return self.parse_cutout_fits(path, observation, subtract_zodi=subtract_zodi)

    def parse_cutout_fits(
        self,
        path: Path | str,
        observation: SpherexObservation | None = None,
        *,
        subtract_zodi: bool = False,
        target_ra: float | None = None,
        target_dec: float | None = None,
    ) -> SpherexCutout:
        path = Path(path)
        with fits.open(path) as hdul:
            # Verified HDU order: 0 PRIMARY, 1 IMAGE, 2 FLAGS, 3 VARIANCE, 4 ZODI, 5 EPSF/PSF, 6 WCS-WAVE
            image_hdu = self._hdu_by_name(hdul, "IMAGE", fallback_index=1)
            flags_hdu = self._hdu_by_name(hdul, "FLAGS", fallback_index=2)
            var_hdu = self._hdu_by_name(hdul, "VARIANCE", fallback_index=3, required=False)
            zodi_hdu = self._hdu_by_name(hdul, "ZODI", fallback_index=4, required=False)

            image = np.asarray(image_hdu.data, dtype=np.float64)
            flags = np.asarray(flags_hdu.data)
            variance = np.asarray(var_hdu.data, dtype=np.float64) if var_hdu is not None else None
            zodi = np.asarray(zodi_hdu.data, dtype=np.float64) if zodi_hdu is not None else None

            if subtract_zodi and zodi is not None:
                image = image - zodi

            spatial_wcs = WCS(image_hdu.header)

            wave_um: Optional[float] = None
            bw_um: Optional[float] = None
            # Wavelength at target (or cutout center) via spectral WCS key "W"
            # as demonstrated in IRSA cutouts notebook.
            try:
                if target_ra is not None and target_dec is not None:
                    from astropy.coordinates import SkyCoord
                    import astropy.units as u

                    coord = SkyCoord(target_ra * u.deg, target_dec * u.deg, frame="icrs")
                    x, y = spatial_wcs.world_to_pixel(coord)
                else:
                    y, x = (np.array(image.shape) - 1) / 2.0

                spectral_wcs = WCS(image_hdu.header, fobj=hdul, key="W")
                spectral_wcs.sip = None
                wave_world = spectral_wcs.pixel_to_world(x, y)
                # Returns wavelength Quantity (and optionally bandwidth depending on WCS)
                if hasattr(wave_world, "to"):
                    wave_um = float(wave_world.to("micron").value)
                elif isinstance(wave_world, (tuple, list)) and len(wave_world) >= 1:
                    wave_um = float(wave_world[0].to("micron").value)
                    if len(wave_world) >= 2 and hasattr(wave_world[1], "to"):
                        bw_um = float(wave_world[1].to("micron").value)
            except Exception as exc:
                logger.info("Could not evaluate spectral WCS at target: %s", exc)

            primary = hdul[0].header
            meta = {
                "VERSION": primary.get("VERSION") or image_hdu.header.get("VERSION"),
                "DATE-OBS": image_hdu.header.get("DATE-OBS") or primary.get("DATE-OBS"),
                "MJD-OBS": image_hdu.header.get("MJD-OBS") or primary.get("MJD-OBS"),
                "TELESCOP": image_hdu.header.get("TELESCOP") or primary.get("TELESCOP"),
                "INSTRUME": image_hdu.header.get("INSTRUME") or primary.get("INSTRUME"),
                "BUNIT": image_hdu.header.get("BUNIT"),
                "NAXIS1": int(image_hdu.header.get("NAXIS1") or image.shape[1]),
                "NAXIS2": int(image_hdu.header.get("NAXIS2") or image.shape[0]),
                "FINAST": image_hdu.header.get("FINAST") or primary.get("FINAST"),
            }

            if observation is None:
                observation = SpherexObservation(
                    obs_id=path.stem,
                    bandpass="UNKNOWN",
                    detector=0,
                    mjd=float(meta.get("MJD-OBS") or 0.0),
                    access_url="",
                    cutout_url="",
                    time_iso=str(meta.get("DATE-OBS") or ""),
                    source="live",
                )

            return SpherexCutout(
                observation=observation,
                image=image,
                flags=flags,
                variance=variance,
                zodi=zodi,
                wcs=spatial_wcs,
                central_wavelength_um=wave_um,
                bandwidth_um=bw_um,
                header_meta=meta,
                flag_summary=summarize_flags(flags),
                fits_path=path,
                source=observation.source,
            )

    # ----------------------------------------------------------------- helpers
    def _tap_csv(self, query: str) -> list[dict[str, str]]:
        r = self.session.get(
            IRSA_TAP_SYNC,
            params={"QUERY": query, "FORMAT": "csv"},
            timeout=self.timeout,
        )
        r.raise_for_status()
        if r.text.lstrip().startswith("<") or "ERROR" in r.text.splitlines()[0:3]:
            # TAP error pages sometimes return 200 with ERROR in body
            if "ERROR" in r.text[:500]:
                raise SpherexAdapterError(f"TAP error: {r.text[:500]}")
        return self._parse_csv(r.text)

    @staticmethod
    def _parse_csv(text: str) -> list[dict[str, str]]:
        import csv
        from io import StringIO

        # Skip VOTable/HTML error bodies
        if not text.strip() or "<" in text[:50]:
            return []
        reader = csv.DictReader(StringIO(text))
        return [dict(row) for row in reader]

    @staticmethod
    def _hdu_by_name(hdul: fits.HDUList, name: str, fallback_index: int, required: bool = True):
        if name in hdul:
            return hdul[name]
        if fallback_index < len(hdul):
            return hdul[fallback_index]
        if required:
            raise SpherexAdapterError(f"Missing HDU {name!r} (index {fallback_index})")
        return None

    @staticmethod
    def _obs_id_from_uri(uri: str) -> str:
        # .../level2_2025W19_1B_0241_1D1_spx_....fits → 2025W19_1B_0241_1
        m = re.search(r"level2_([^/]+?)D[1-6]_spx_", uri)
        if m:
            return m.group(1)
        return ""

    @staticmethod
    def _collection_from_uri(uri: str) -> str:
        if "/dr1/" in uri:
            return "spherex_dr1"
        if "/qr3/" in uri:
            return "spherex_qr3"
        if "/qr2/" in uri:
            return "spherex_qr2"
        return ""

    def _cache_path(self, url: str) -> Path:
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
        stem = Path(url.split("?")[0]).stem
        return self.cache_dir / "cutouts" / f"{stem}_{digest}.fits"

    def _download(self, url: str, path: Path, retries: int = 1) -> None:
        last_err: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                logger.info("Downloading cutout (attempt %s/%s) %s", attempt, retries, url)
                _curl_download(url, path, timeout=self.timeout)
                return
            except (SpherexAdapterError, OSError) as exc:
                last_err = exc
                logger.warning("Cutout download failed (%s); retrying…", exc)
                import time

                time.sleep(0)
        raise SpherexAdapterError(f"Failed to download cutout after {retries} tries: {last_err}")
