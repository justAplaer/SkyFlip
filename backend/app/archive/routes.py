
from fastapi import APIRouter, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from astropy.coordinates import SkyCoord

import requests
import pandas as pd
import numpy as np
import matplotlib

from io import StringIO, BytesIO
from urllib.parse import urlparse, unquote
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
import astropy.units as u
from functools import lru_cache

from .analysis_pipeline import analyze_observations

matplotlib.use("Agg")
import matplotlib.pyplot as plt


class AnalysisRequest(BaseModel):
    url1: str
    url2: str

class GaiaOverlayRequest(BaseModel):
    url: str
    sources: list[dict]
    observation_mjd: float | None = None


app = APIRouter(prefix="/api/archive", tags=["Archive tools (Part 1)"])


def validate_spherex_fits_url(url):
    parsed_url = urlparse(url)
    try:
        port = parsed_url.port
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid SPHEREx FITS URL.")

    if (
        parsed_url.scheme != "https"
        or parsed_url.hostname != "irsa.ipac.caltech.edu"
        or parsed_url.username is not None
        or parsed_url.password is not None
        or port not in (None, 443)
        or ".." in unquote(parsed_url.path).split("/")
        or not parsed_url.path.startswith("/ibe/data/spherex/")
        or not parsed_url.path.endswith(".fits")
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid SPHEREx FITS URL."
        )


def fetch_validated_fits(url, timeout):
    # Redirects cannot bypass the archive hostname allowlist.
    validate_spherex_fits_url(url)
    response = requests.get(url, timeout=timeout, allow_redirects=False)
    if 300 <= response.status_code < 400:
        raise requests.exceptions.RequestException("Archive redirect refused")
    response.raise_for_status()
    return response


@app.get("/")
def home():
    return {"message": "SPHEREx backend is running"}


@app.get("/search")
def search_observations(
    ra: float = Query(ge=0, le=360),
    dec: float = Query(ge=-90, le=90),
    radius: float = Query(default=0.01, gt=0, le=1.0),
    page: int = Query(default=1, ge=1)
):
    collections = [
        "spherex_dr1",
        "spherex_dr1_deep",
        "spherex_qr3",
        "spherex_qr3_deep"
    ]

    all_tables = []

    for collection in collections:
        params = {
            "COLLECTION": collection,
            "POS": f"circle {ra} {dec} {radius}",
            "RESPONSEFORMAT": "HTML",
            "MAXREC": 1000
        }

        try:
            response = requests.get(
                "https://irsa.ipac.caltech.edu/SIA",
                params=params,
                timeout=30
            )

            response.raise_for_status()

            tables = pd.read_html(StringIO(response.text))

            if tables and not tables[0].empty:
                table = tables[0].copy()
                table["collection"] = collection
                all_tables.append(table)

            print(
                f"{collection}: "
                f"{len(tables[0]) if tables else 0} observations"
            )

        except (requests.RequestException, ValueError) as error:
            print(f"Error searching {collection}: {error}")

    if not all_tables:
        return {
            "ra": ra,
            "dec": dec,
            "radius": radius,
            "page": page,
            "observations_found": 0,
            "has_more": False,
            "observations": []
        }

    combined = pd.concat(all_tables, ignore_index=True)

    combined["observation_date"] = Time(
        combined["t_min"].to_numpy(),
        format="mjd"
    ).iso

    metadata_columns = [
        "obs_id",
        "obs_collection",
        "obs_release_date",
        "facility_name",
        "instrument_name",
        "proposal_title",
        "proposal_id",
        "proposal_pi",
        "proposal_project",
        "algorithm_name",
        "s_ra",
        "s_dec",
        "t_min",
        "t_max",
        "observation_date",
        "t_exptime",
        "energy_bandpassname",
        "energy_emband",
        "em_min",
        "em_max",
        "em_res_power",
        "s_resolution",
        "s_xel1",
        "s_xel2",
        "s_pixel_scale",
        "s_fov",
        "target_name",
        "target_type",
        "target_standard",
        "target_moving",
        "calib_level",
        "dataproduct_type",
        "dataproduct_subtype",
        "obs_intent",
        "environment_photometric",
        "position_timedependent",
        "access_format",
        "access_estsize",
        "access_url"
    ]

    available_columns = [
        column
        for column in metadata_columns
        if column in combined.columns
    ]

    observations = (
        combined[available_columns]
        .sort_values("t_min", kind="stable")
        .drop_duplicates(
            subset=["obs_id", "energy_bandpassname"]
        )
    )

    total_found = len(observations)

    page_size = 100
    start = (page - 1) * page_size
    end = start + page_size

    observations = observations.iloc[start:end]

    print(
        f"Returning page {page}: "
        f"{len(observations)} observations"
    )

    observations = observations.astype(object).where(
        pd.notna(observations), None
    )

    return {
        "ra": ra,
        "dec": dec,
        "radius": radius,
        "page": page,
        "page_size": page_size,
        "observations_found": total_found,
        "has_more": end < total_found,
        "observations": observations.to_dict(orient="records")
    }


@app.get("/gaia-sources")
def get_gaia_sources(
    ra: float = Query(ge=0, le=360),
    dec: float = Query(ge=-90, le=90),
    radius: float = Query(default=0.01, gt=0, le=1.0)
):
    """
    Retrieve nearby Gaia DR3 sources around a searched sky position.
    Returns up to 100 sources, ordered by G-band brightness.
    """

    query = f"""
        SELECT TOP 100
            source_id,
            ra,
            dec,
            parallax,
            pmra,
            pmdec,
            phot_g_mean_mag,
            phot_bp_mean_mag,
            phot_rp_mean_mag,
            DISTANCE(
                POINT('ICRS', ra, dec),
                POINT('ICRS', {ra}, {dec})
            ) AS separation_deg
        FROM gaiadr3.gaia_source
        WHERE 1 = CONTAINS(
            POINT('ICRS', ra, dec),
            CIRCLE('ICRS', {ra}, {dec}, {radius})
        )
        ORDER BY phot_g_mean_mag ASC
    """

    params = {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "csv",
        "QUERY": query
    }

    try:
        response = requests.get(
            "https://gea.esac.esa.int/tap-server/tap/sync",
            params=params,
            timeout=90
        )

        response.raise_for_status()

        table = pd.read_csv(StringIO(response.text))

        table = table.astype(object).where(
            pd.notna(table), None
        )

        sources = table.to_dict(orient="records")

        return {
            "catalog": "Gaia DR3",
            "ra": ra,
            "dec": dec,
            "radius": radius,
            "sources_found": len(sources),
            "sources": sources
        }

    except requests.exceptions.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"Gaia archive request failed: {str(error)}"
        )

    except (ValueError, pd.errors.ParserError) as error:
        raise HTTPException(
            status_code=502,
            detail=f"Unable to process Gaia catalog results: {str(error)}"
        )



@app.get("/cube-search")
def search_all_sky_cube(
    ra: float = Query(ge=0, le=360),
    dec: float = Query(ge=-90, le=90),
    radius: float = Query(default=0.01, gt=0, le=1.0)
):
    """
    Find SPHEREx DR1 All-Sky Cube tiles covering a sky position.
    Retries temporary IRSA gateway and server errors.
    """

    params = {
        "COLLECTION": "spherex_dr1_cube",
        "POS": f"circle {ra} {dec} {radius}",
        "RESPONSEFORMAT": "HTML",
        "MAXREC": 20
    }

    session = requests.Session()

    retry_strategy = Retry(
        total=4,
        connect=3,
        read=2,
        status=4,
        backoff_factor=2,
        status_forcelist=[502, 503, 504],
        allowed_methods=frozenset(["GET"]),
        respect_retry_after_header=True
    )

    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)

    try:
        response = session.get(
            "https://irsa.ipac.caltech.edu/SIA",
            params=params,
            timeout=(20, 120)
        )

        response.raise_for_status()

        tables = pd.read_html(StringIO(response.text))

        cube_table = next(
            (
                table for table in tables
                if "access_url" in table.columns
            ),
            None
        )

        if cube_table is None:
            raise HTTPException(
                status_code=502,
                detail="IRSA did not return a recognizable cube result table."
            )

        metadata_columns = [
            "obs_id",
            "obs_collection",
            "s_ra",
            "s_dec",
            "s_region",
            "s_fov",
            "em_min",
            "em_max",
            "dataproduct_type",
            "dataproduct_subtype",
            "access_format",
            "access_estsize",
            "access_url"
        ]

        available_columns = [
            column for column in metadata_columns
            if column in cube_table.columns
        ]

        cube_table = cube_table[available_columns].copy()

        cube_table = cube_table.astype(object).where(
            pd.notna(cube_table), None
        )

        tiles = cube_table.to_dict(orient="records")

        for tile in tiles:
            url = tile.get("access_url")

            if not isinstance(url, str):
                raise HTTPException(
                    status_code=502,
                    detail="IRSA returned a cube without a valid access URL."
                )

            validate_spherex_fits_url(url)

        return {
            "catalog": "SPHEREx DR1 All-Sky Cube",
            "ra": ra,
            "dec": dec,
            "radius": radius,
            "tiles_found": len(tiles),
            "tiles": tiles
        }

    except requests.exceptions.RequestException as error:
        print("IRSA cube search failed after retries:", repr(error))

        raise HTTPException(
            status_code=502,
            detail=(
                "IRSA cube search failed after multiple attempts. "
                f"Upstream error: {str(error)}"
            )
        )

    except ValueError as error:
        print("Unable to process IRSA cube results:", repr(error))

        raise HTTPException(
            status_code=502,
            detail=f"Unable to process IRSA cube results: {str(error)}"
        )

    finally:
        session.close()


@app.get("/cube-info")
def get_cube_info(access_url: str = Query(...)):
    """
    Download a SPHEREx All-Sky Cube FITS file and inspect its structure.
    """

    validate_spherex_fits_url(access_url)

    try:
        response = fetch_validated_fits(access_url, timeout=30)
        response.raise_for_status()

        with fits.open(BytesIO(response.content), memmap=False) as hdul:
            extensions = []

            for index, hdu in enumerate(hdul):
                extensions.append({
                    "index": index,
                    "name": hdu.name,
                    "type": type(hdu).__name__,
                    "shape": (
                        list(hdu.data.shape)
                        if hdu.data is not None and hasattr(hdu.data, "shape")
                        else None
                    ),
                    "header": {
                        key: hdu.header[key]
                        for key in [
                            "BUNIT",
                            "NAXIS",
                            "NAXIS1",
                            "NAXIS2",
                            "NAXIS3",
                            "CTYPE1",
                            "CTYPE2",
                            "CTYPE3",
                            "CUNIT1",
                            "CUNIT2",
                            "CUNIT3",
                            "CRVAL1",
                            "CRVAL2",
                            "CRVAL3",
                            "CRPIX1",
                            "CRPIX2",
                            "CRPIX3",
                            "CDELT1",
                            "CDELT2",
                            "CDELT3"
                        ]
                        if key in hdu.header
                    }
                })

            channel_info = None

            if "SPECTRAL_CHANNELS" in hdul:
                channel_hdu = hdul["SPECTRAL_CHANNELS"]

                channel_info = {
                    "columns": (
                        list(channel_hdu.columns.names)
                        if channel_hdu.columns
                        else []
                    ),
                    "row_count": (
                        len(channel_hdu.data)
                        if channel_hdu.data is not None
                        else 0
                    )
                }

                if channel_hdu.data is not None:
                    sample_rows = []

                    for row in channel_hdu.data[:5]:
                        sample = {}

                        for column in channel_hdu.columns.names:
                            value = row[column]

                            if hasattr(value, "tolist"):
                                value = value.tolist()
                            elif hasattr(value, "item"):
                                value = value.item()

                            sample[column] = value

                        sample_rows.append(sample)

                    channel_info["first_five_rows"] = sample_rows

            image_shape = None

            if "IMAGE" in hdul and hdul["IMAGE"].data is not None:
                image_shape = list(hdul["IMAGE"].data.shape)

            return {
                "status": "success",
                "filename": access_url.split("/")[-1],
                "file_size_bytes": len(response.content),
                "image_shape": image_shape,
                "extensions": extensions,
                "spectral_channels": channel_info
            }

    except requests.exceptions.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"Unable to download cube FITS file: {str(error)}"
        )

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to inspect cube FITS file: {str(error)}"
        )

@lru_cache(maxsize=1)
def load_cube_for_viewer(access_url: str):
    """
    Download and cache one All-Sky Cube's science image and channel metadata.
    The IMAGE array is cached so channel changes do not redownload the FITS file.
    """

    response = fetch_validated_fits(access_url, timeout=60)
    response.raise_for_status()

    with fits.open(BytesIO(response.content), memmap=False) as hdul:
        image_data = np.array(
            hdul["IMAGE"].data,
            dtype=np.float32,
            copy=True
        )

        channel_table = hdul["SPECTRAL_CHANNELS"].data

        channels = []

        for row in channel_table:
            channels.append({
                "wavelength": float(row["WAVELENGTH"]),
                "wl_min": float(row["WL_MIN"]),
                "wl_max": float(row["WL_MAX"]),
                "bandwidth": float(row["BANDWIDTH"]),
                "detector": int(row["DETECTOR"]),
                "subchannel": int(row["SUBCHAN"])
            })

    return image_data, channels


@app.get("/cube-channel")
def get_cube_channel(
    access_url: str = Query(...),
    channel: int = Query(ge=1, le=102)
):
    """
    Render one wavelength plane from a SPHEREx All-Sky Cube.
    Channel numbers are 1-based.
    """

    validate_spherex_fits_url(access_url)

    try:
        image_data, channels = load_cube_for_viewer(access_url)

        if channel > image_data.shape[0]:
            raise HTTPException(
                status_code=404,
                detail="The requested channel does not exist in this cube."
            )

        # Convert the user's 1-based channel number to a Python index.
        plane = image_data[channel - 1]

        valid = np.isfinite(plane)

        if not np.any(valid):
            raise HTTPException(
                status_code=404,
                detail=f"Channel {channel} contains no valid image data."
            )

        wavelength_info = channels[channel - 1]

        vmin, vmax = np.percentile(
            plane[valid],
            [1, 99]
        )

        if vmax <= vmin:
            vmax = vmin + 1e-6

        fig, ax = plt.subplots(figsize=(7, 7))

        image = ax.imshow(
            plane,
            origin="lower",
            cmap="inferno",
            vmin=vmin,
            vmax=vmax
        )

        ax.set_title(
            f"SPHEREx All-Sky Cube — "
            f"{wavelength_info['wavelength']:.3f} μm"
        )
        ax.set_xlabel("Pixel")
        ax.set_ylabel("Pixel")

        colorbar = fig.colorbar(image, ax=ax)
        colorbar.set_label("MJy/sr")

        fig.tight_layout()

        buffer = BytesIO()
        fig.savefig(
            buffer,
            format="png",
            dpi=120,
            bbox_inches="tight"
        )
        plt.close(fig)
        buffer.seek(0)

        return Response(
            content=buffer.getvalue(),
            media_type="image/png",
            headers={
                "X-Cube-Channel": str(channel),
                "X-Cube-Wavelength-Um": str(
                    wavelength_info["wavelength"]
                ),
                "X-Cube-Bandwidth-Um": str(
                    wavelength_info["bandwidth"]
                ),
                "X-Cube-Detector": str(
                    wavelength_info["detector"]
                ),
                "X-Cube-Subchannel": str(
                    wavelength_info["subchannel"]
                ),
                "X-Cube-Bunit": "MJy/sr",
                "Access-Control-Expose-Headers": (
                    "X-Cube-Channel, X-Cube-Wavelength-Um, "
                    "X-Cube-Bandwidth-Um, X-Cube-Detector, "
                    "X-Cube-Subchannel, X-Cube-Bunit"
                )
            }
        )

    except requests.exceptions.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"Unable to download cube FITS file: {str(error)}"
        )

    except HTTPException:
        raise

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to render cube channel: {str(error)}"
        )

def print_fits_quality_report(hdul):
    """
    Optional diagnostic helper.

    Retained for later quality-flag work, but not called
    automatically every time an image is rendered.
    """

    image_hdu = hdul["IMAGE"]

    print("\n========== FITS QUALITY ==========")
    print("Observation ID:", image_hdu.header.get("OBSID", "Unavailable"))
    print("Detector:", image_hdu.header.get("DETECTOR", "Unavailable"))
    print("L1 Quality:", image_hdu.header.get("L1DQAFLG", "Unavailable"))
    print("L2 Quality:", image_hdu.header.get("L2DQAFLG", "Unavailable"))

    if "FLAGS" not in hdul or hdul["FLAGS"].data is None:
        print("No pixel FLAGS data found.")
        return

    flags_hdu = hdul["FLAGS"]
    flags_data = flags_hdu.data
    total_pixels = flags_data.size

    for key in flags_hdu.header:
        if not key.startswith("MSKN"):
            continue

        flag_name = flags_hdu.header[key]
        suffix = key.replace("MSKN", "")
        mask = flags_hdu.header.get(f"MSKM{suffix}")

        if mask is None:
            continue

        flagged_pixels = np.count_nonzero(
            np.bitwise_and(flags_data, mask) != 0
        )

        percentage = (
            flagged_pixels / total_pixels * 100
            if total_pixels > 0
            else 0
        )

        print(
            f"{flag_name}: {flagged_pixels:,} "
            f"({percentage:.3f}%)"
        )

    print("==================================\n")


@lru_cache(maxsize=32)
def render_cached_image(url: str):
    response = fetch_validated_fits(url, timeout=60)
    response.raise_for_status()

    with fits.open(BytesIO(response.content)) as hdul:
        image_data = hdul["IMAGE"].data

        valid_pixels = image_data[np.isfinite(image_data)]

        if valid_pixels.size == 0:
            raise ValueError("FITS image contains no valid pixels.")

        vmin = np.percentile(valid_pixels, 1)
        vmax = np.percentile(valid_pixels, 99)

        fig, ax = plt.subplots(figsize=(8, 8))

        try:
            ax.imshow(
                image_data,
                cmap="gray",
                origin="lower",
                vmin=vmin,
                vmax=vmax
            )

            ax.set_title("SPHEREx Observation")
            ax.set_xlabel("Pixel")
            ax.set_ylabel("Pixel")

            buffer = BytesIO()

            fig.savefig(
                buffer,
                format="png",
                bbox_inches="tight"
            )

            return buffer.getvalue()

        finally:
            plt.close(fig)


@lru_cache(maxsize=128)
def calculate_spectral_info(url: str, ra: float, dec: float):
    """
    Calculate the approximate central wavelength and bandwidth
    at a requested sky position in a SPHEREx spectral image.

    The spatial WCS converts RA/DEC to image pixels.
    The alternative spectral WCS (key W) converts those pixels
    to wavelength and bandwidth.
    """

    response = fetch_validated_fits(url, timeout=90)
    response.raise_for_status()

    with fits.open(BytesIO(response.content), memmap=False) as hdul:
        image_hdu = hdul["IMAGE"]
        image_data = image_hdu.data

        if image_data is None or image_data.ndim != 2:
            raise ValueError("The FITS IMAGE extension is not a 2D image.")

        # Convert the requested sky position to image pixel coordinates.
        spatial_wcs = WCS(image_hdu.header).celestial

        pixel_x, pixel_y = spatial_wcs.world_to_pixel_values(
            ra,
            dec
        )

        if not np.isfinite(pixel_x) or not np.isfinite(pixel_y):
            raise ValueError(
                "Could not convert the requested coordinates to image pixels."
            )

        height, width = image_data.shape

        if (
            pixel_x < 0
            or pixel_x >= width
            or pixel_y < 0
            or pixel_y >= height
        ):
            raise ValueError(
                "The searched sky position is outside this observation's image."
            )

        # Read the alternative spectral WCS from the FITS file.
        spectral_wcs = WCS(
            header=image_hdu.header,
            fobj=hdul,
            key="W"
        )

        # The spectral wavelength model is independent of the
        # telescope's spatial SIP distortion.
        spectral_wcs.sip = None

        wavelength, bandwidth = spectral_wcs.pixel_to_world(
            pixel_x,
            pixel_y
        )

        wavelength_um = float(wavelength.to_value(u.um))
        bandwidth_um = float(bandwidth.to_value(u.um))

        if (
            not np.isfinite(wavelength_um)
            or not np.isfinite(bandwidth_um)
            or wavelength_um <= 0
            or bandwidth_um <= 0
        ):
            raise ValueError(
                "The FITS file did not return valid wavelength information."
            )

        half_bandwidth = bandwidth_um / 2

        return {
            "ra": float(ra),
            "dec": float(dec),
            "pixel_x": float(pixel_x),
            "pixel_y": float(pixel_y),
            "wavelength_um": wavelength_um,
            "bandwidth_um": bandwidth_um,
            "wavelength_min_um": wavelength_um - half_bandwidth,
            "wavelength_max_um": wavelength_um + half_bandwidth,
            "detector": str(
                image_hdu.header.get("DETECTOR", "Unavailable")
            ),
            "obs_id": str(
                image_hdu.header.get("OBSID", "Unavailable")
            ),
            "units": "micrometers"
        }


@app.get("/spectral-info")
def get_spectral_info(
    url: str,
    ra: float = Query(ge=0, le=360),
    dec: float = Query(ge=-90, le=90)
):
    validate_spherex_fits_url(url)

    try:
        return calculate_spectral_info(url, ra, dec)

    except requests.exceptions.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"SPHEREx FITS download failed: {str(error)}"
        )

    except (
        ValueError,
        KeyError,
        IndexError,
        TypeError,
        AttributeError
    ) as error:
        raise HTTPException(
            status_code=422,
            detail=f"Unable to calculate spectral information: {str(error)}"
        )



@app.post("/gaia-overlay")
def get_gaia_overlay(request: GaiaOverlayRequest):
    """
    Render a SPHEREx observation with Gaia DR3 catalog positions
    marked on the image.
    """

    validate_spherex_fits_url(request.url)

    try:
        response = fetch_validated_fits(request.url, timeout=90)
        response.raise_for_status()

        with fits.open(BytesIO(response.content), memmap=False) as hdul:
            image_hdu = hdul["IMAGE"]
            image_data = np.asarray(
                image_hdu.data,
                dtype=np.float32
            )

            if image_data.ndim != 2:
                raise ValueError("Expected a 2D SPHEREx image.")

            spatial_wcs = WCS(image_hdu.header).celestial

            height, width = image_data.shape

            marker_x = []
            marker_y = []

            for source in request.sources:
                source_ra = source.get("ra")
                source_dec = source.get("dec")

                if source_ra is None or source_dec is None:
                    continue

                ra = float(source_ra)
                dec = float(source_dec)

                # Gaia DR3 positions are referenced to epoch 2016.0.
                # Propagate using proper motion when the observation
                # date and proper-motion measurements are available.
                if request.observation_mjd is not None:
                    pmra = source.get("pmra")
                    pmdec = source.get("pmdec")

                    if pmra is not None and pmdec is not None:
                        try:
                            coordinate = SkyCoord(
                                ra=ra * u.deg,
                                dec=dec * u.deg,
                                pm_ra_cosdec=float(pmra) * u.mas / u.yr,
                                pm_dec=float(pmdec) * u.mas / u.yr,
                                obstime=Time(2016.0, format="jyear")
                            )

                            propagated = coordinate.apply_space_motion(
                                new_obstime=Time(
                                    request.observation_mjd,
                                    format="mjd"
                                )
                            )

                            ra = propagated.ra.deg
                            dec = propagated.dec.deg

                        except (ValueError, TypeError, AttributeError):
                            # Retain the catalog position if propagation
                            # cannot be calculated for this source.
                            pass

                pixel_x, pixel_y = spatial_wcs.world_to_pixel_values(
                    ra,
                    dec
                )

                if not np.isfinite(pixel_x) or not np.isfinite(pixel_y):
                    continue

                # Keep only positions inside the actual image.
                if (
                    -0.5 <= pixel_x <= width - 0.5
                    and -0.5 <= pixel_y <= height - 0.5
                ):
                    marker_x.append(pixel_x)
                    marker_y.append(pixel_y)

            valid_pixels = image_data[np.isfinite(image_data)]

            if valid_pixels.size == 0:
                raise ValueError("FITS image contains no valid pixels.")

            vmin, vmax = np.percentile(valid_pixels, [1, 99])

            if vmax <= vmin:
                vmax = vmin + 1e-6

            # Keep the same figure dimensions and plotting layout
            # as render_cached_image so the image presentation
            # remains consistent.
            fig, ax = plt.subplots(figsize=(8, 8))

            try:
                ax.imshow(
                    image_data,
                    cmap="gray",
                    origin="lower",
                    vmin=vmin,
                    vmax=vmax
                )

                if marker_x:
                    ax.scatter(
                        marker_x,
                        marker_y,
                        s=85,
                        marker="o",
                        facecolors="none",
                        edgecolors="#00ffff",
                        linewidths=1.4,
                        label="Gaia DR3 catalog positions"
                    )

                ax.set_title("SPHEREx Observation — Gaia DR3 Overlay")
                ax.set_xlabel("Pixel")
                ax.set_ylabel("Pixel")

                buffer = BytesIO()

                fig.savefig(
                    buffer,
                    format="png",
                    bbox_inches="tight"
                )

                buffer.seek(0)

                return Response(
                    content=buffer.getvalue(),
                    media_type="image/png",
                    headers={
                        "X-Gaia-Sources-Plotted": str(len(marker_x)),
                        "Access-Control-Expose-Headers":
                            "X-Gaia-Sources-Plotted"
                    }
                )

            finally:
                plt.close(fig)

    except requests.exceptions.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"SPHEREx FITS download failed: {str(error)}"
        )

    except (ValueError, KeyError, TypeError, IndexError) as error:
        raise HTTPException(
            status_code=422,
            detail=f"Unable to create Gaia overlay: {str(error)}"
        )


@app.get("/image")
def get_image(url: str):
    validate_spherex_fits_url(url)

    try:
        image_bytes = render_cached_image(url)

    except requests.exceptions.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"SPHEREx image download failed: {str(error)}"
        )

    except ValueError as error:
        raise HTTPException(
            status_code=500,
            detail=f"FITS image processing failed: {str(error)}"
        )

    return Response(
        content=image_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=3600"
        }
    )


@app.post("/analyze")
def analyze(request: AnalysisRequest):
    validate_spherex_fits_url(request.url1)
    validate_spherex_fits_url(request.url2)

    try:
        response1 = fetch_validated_fits(request.url1, timeout=60)
        response1.raise_for_status()

        response2 = fetch_validated_fits(request.url2, timeout=60)
        response2.raise_for_status()

    except requests.exceptions.RequestException as error:
        print("SPHEREx download error:", repr(error))

        raise HTTPException(
            status_code=502,
            detail=f"SPHEREx download failed: {str(error)}"
        )

    try:
        results = analyze_observations(
            response1.content,
            response2.content
        )

        return results

    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=f"Observation analysis failed: {str(error)}"
        )
