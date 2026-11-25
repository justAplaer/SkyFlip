
from io import BytesIO
import base64

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from astropy.io import fits
from astropy.wcs import WCS

from scipy.ndimage import (
    map_coordinates,
    gaussian_filter,
    label,
)


# Pixel-quality flags that may make image comparison unreliable.
# SOURCE and FULLSAMPLE are intentionally retained.
BAD_FLAGS = {
    "TRANSIENT": 1,
    "OVERFLOW": 2,
    "SUR_ERROR": 4,
    "NONFUNC": 64,
    "DICHROIC": 128,
    "MISSING_DATA": 512,
    "HOT": 1024,
    "COLD": 2048,
    "PHANMISS": 16384,
    "NONLINEAR": 32768,
    "PERSIST": 131072,
    "OUTLIER": 524288,
    "CROSSTALK": 1048576,
    "GHOST": 4194304,
    "GHOST_FPA": 8388608,
    "GHOST_EXT": 16777216,
    "STREAK": 33554432,
    "BLOOM": 67108864,
    "SNOWBALL": 134217728,
    "HALO": 268435456,
}

# Candidate detection settings.
SIGNIFICANCE_SIGMA = 5.0
MIN_REGION_PIXELS = 3
LOCAL_NOISE_SMOOTHING = 15
MAX_REPORTED_CANDIDATES = 100


def read_fits_image_and_flags(fits_bytes):
    """Read the science image, WCS, and optional pixel-quality flags."""

    with fits.open(BytesIO(fits_bytes)) as hdul:
        image_hdu = hdul["IMAGE"]

        image = np.array(image_hdu.data, dtype=float)
        wcs = WCS(image_hdu.header)

        flags_available = (
            "FLAGS" in hdul and hdul["FLAGS"].data is not None
        )

        if flags_available:
            flags = np.asarray(
                hdul["FLAGS"].data,
                dtype=np.int64
            )

            if flags.shape != image.shape:
                raise ValueError(
                    "The FLAGS extension shape does not match the IMAGE shape."
                )
        else:
            flags = np.zeros(image.shape, dtype=np.int64)

    if image.ndim != 2:
        raise ValueError("Both observations must contain 2D images.")

    return image, wcs, flags, flags_available


def get_bad_pixel_mask(flags):
    """Identify pixels containing any selected quality flag."""

    bad_mask = np.zeros(flags.shape, dtype=bool)

    for bit_value in BAD_FLAGS.values():
        bad_mask |= (flags & bit_value) != 0

    return bad_mask


def estimate_noise(difference, valid_mask):
    """
    Estimate global and spatially varying noise.

    A robust MAD estimate reduces sensitivity to unusually large
    astronomical signals and image artifacts.
    """

    values = difference[valid_mask]

    median_value = np.median(values)

    mad = np.median(np.abs(values - median_value))
    global_sigma = 1.4826 * mad

    if not np.isfinite(global_sigma) or global_sigma <= 0:
        global_sigma = np.std(values)

    if not np.isfinite(global_sigma) or global_sigma <= 0:
        global_sigma = 1e-10

    clipped = np.clip(
        difference,
        -5.0 * global_sigma,
        5.0 * global_sigma
    )

    clipped_squared = np.zeros(difference.shape, dtype=float)
    clipped_squared[valid_mask] = clipped[valid_mask] ** 2

    local_variance = gaussian_filter(
        clipped_squared,
        sigma=LOCAL_NOISE_SMOOTHING
    )

    local_noise = np.sqrt(np.maximum(local_variance, 0))

    local_noise = np.maximum(
        local_noise,
        global_sigma * 0.5
    )

    return global_sigma, local_noise


def detect_candidate_regions(
    corrected_difference,
    overlap_mask,
    local_noise,
):
    """
    Detect statistically unusual pixels and group adjacent pixels
    into candidate regions.

    Records local-noise measurements and exact peak-pixel coordinates.
    """

    threshold_map = SIGNIFICANCE_SIGMA * local_noise

    positive_mask = (
        overlap_mask
        & (corrected_difference > threshold_map)
    )

    negative_mask = (
        overlap_mask
        & (corrected_difference < -threshold_map)
    )

    height, width = corrected_difference.shape
    regions = []

    def collect_regions(candidate_mask, polarity):
        labels, count = label(candidate_mask)

        if count == 0:
            return

        flat_indices = np.flatnonzero(labels)
        label_ids = labels.ravel()[flat_indices]

        values = corrected_difference.ravel()[flat_indices]
        noise_values = local_noise.ravel()[flat_indices]
        weights = np.abs(values)

        areas = np.bincount(
            label_ids,
            minlength=count + 1
        )

        valid_ids = np.flatnonzero(
            areas >= MIN_REGION_PIXELS
        )
        valid_ids = valid_ids[valid_ids != 0]

        if len(valid_ids) == 0:
            return

        peak_values = np.full(
            count + 1,
            -np.inf if polarity == "positive" else np.inf
        )

        if polarity == "positive":
            np.maximum.at(peak_values, label_ids, values)
        else:
            np.minimum.at(peak_values, label_ids, values)

        peak_matches = (
            values == peak_values[label_ids]
        )

        peak_indices = np.full(
            count + 1,
            corrected_difference.size,
            dtype=np.int64
        )

        np.minimum.at(
            peak_indices,
            label_ids[peak_matches],
            flat_indices[peak_matches]
        )

        rows = flat_indices // width
        cols = flat_indices % width

        total_weights = np.bincount(
            label_ids,
            weights=weights,
            minlength=count + 1
        )

        weighted_rows = np.bincount(
            label_ids,
            weights=weights * rows,
            minlength=count + 1
        )

        weighted_cols = np.bincount(
            label_ids,
            weights=weights * cols,
            minlength=count + 1
        )

        mean_values = np.bincount(
            label_ids,
            weights=values,
            minlength=count + 1
        ) / np.maximum(areas, 1)

        mean_local_noise = np.bincount(
            label_ids,
            weights=noise_values,
            minlength=count + 1
        ) / np.maximum(areas, 1)

        for region_id in valid_ids:
            peak_index = peak_indices[region_id]

            peak_row, peak_col = divmod(
                int(peak_index),
                width
            )

            peak_difference = float(
                peak_values[region_id]
            )

            peak_noise = float(
                local_noise[peak_row, peak_col]
            )

            average_region_noise = float(
                mean_local_noise[region_id]
            )

            significance = (
                abs(peak_difference) / peak_noise
                if peak_noise > 0
                else 0.0
            )

            regions.append({
                "polarity": polarity,

                "center_x": round(
                    float(
                        weighted_cols[region_id]
                        / total_weights[region_id]
                    ),
                    2
                ),

                "center_y": round(
                    float(
                        weighted_rows[region_id]
                        / total_weights[region_id]
                    ),
                    2
                ),

                # Exact pixel location of the strongest difference.
                "peak_x": int(peak_col),
                "peak_y": int(peak_row),

                "area_pixels": int(areas[region_id]),

                "mean_difference": float(
                    mean_values[region_id]
                ),

                "peak_difference": peak_difference,

                "peak_noise": peak_noise,

                "mean_local_noise": average_region_noise,

                "peak_significance": round(
                    float(significance),
                    2
                ),
            })

    collect_regions(positive_mask, "positive")
    collect_regions(negative_mask, "negative")

    regions.sort(
        key=lambda item: item["peak_significance"],
        reverse=True
    )

    return positive_mask, negative_mask, regions


def analyze_observations(fits_bytes1, fits_bytes2):

    # ---------------------------------------------------------
    # 1. Read both FITS observations.
    # ---------------------------------------------------------

    image1, wcs1, flags1, flags_available1 = (
        read_fits_image_and_flags(fits_bytes1)
    )

    image2, wcs2, flags2, flags_available2 = (
        read_fits_image_and_flags(fits_bytes2)
    )

    # ---------------------------------------------------------
    # 2. Align image 2 with image 1 using their WCS coordinates.
    # ---------------------------------------------------------

    rows1, cols1 = np.indices(image1.shape)

    ra, dec = wcs1.pixel_to_world_values(cols1, rows1)

    x2, y2 = wcs2.world_to_pixel_values(ra, dec)

    aligned_image2 = map_coordinates(
        image2,
        [y2, x2],
        order=1,
        mode="constant",
        cval=np.nan
    )

    aligned_flags2 = map_coordinates(
        flags2,
        [y2, x2],
        order=0,
        mode="constant",
        cval=-1
    ).astype(np.int64)

    # ---------------------------------------------------------
    # 3. Identify valid overlapping pixels.
    # ---------------------------------------------------------

    inside_image2 = (
        np.isfinite(x2)
        & np.isfinite(y2)
        & (x2 >= 0)
        & (x2 <= image2.shape[1] - 1)
        & (y2 >= 0)
        & (y2 <= image2.shape[0] - 1)
    )

    base_overlap_mask = (
        inside_image2
        & np.isfinite(image1)
        & np.isfinite(aligned_image2)
    )

    base_overlap_pixels = int(
        np.count_nonzero(base_overlap_mask)
    )

    if base_overlap_pixels == 0:
        raise ValueError(
            "The two observations have no overlapping valid pixels."
        )

    # ---------------------------------------------------------
    # 4. Apply pixel-quality filtering.
    # ---------------------------------------------------------

    bad_pixels1 = get_bad_pixel_mask(flags1)
    bad_pixels2 = get_bad_pixel_mask(aligned_flags2)

    flagged_in_image1 = (
        base_overlap_mask & bad_pixels1
    )

    flagged_in_image2 = (
        base_overlap_mask & bad_pixels2
    )

    quality_excluded_mask = (
        bad_pixels1 | bad_pixels2
    )

    overlap_mask = (
        base_overlap_mask
        & ~quality_excluded_mask
    )

    overlap_pixels = int(
        np.count_nonzero(overlap_mask)
    )

    quality_excluded_pixels = int(
        np.count_nonzero(
            base_overlap_mask & quality_excluded_mask
        )
    )

    if overlap_pixels == 0:
        raise ValueError(
            "No valid overlapping pixels remain after quality filtering. "
            "Try another observation pair."
        )

    # ---------------------------------------------------------
    # 5. Calculate and correct the difference image.
    # ---------------------------------------------------------

    difference = np.full(
        image1.shape,
        np.nan,
        dtype=float
    )

    difference[overlap_mask] = (
        image1[overlap_mask]
        - aligned_image2[overlap_mask]
    )

    median_offset = float(
        np.median(difference[overlap_mask])
    )

    corrected_difference = np.full(
        image1.shape,
        np.nan,
        dtype=float
    )

    corrected_difference[overlap_mask] = (
        difference[overlap_mask] - median_offset
    )

    valid_differences = corrected_difference[overlap_mask]

    mean_difference = float(
        np.mean(valid_differences)
    )

    median_difference = float(
        np.median(valid_differences)
    )

    std_difference = float(
        np.std(valid_differences)
    )

    # ---------------------------------------------------------
    # 6. Estimate noise and detect significant changes.
    # ---------------------------------------------------------

    global_sigma, local_noise = estimate_noise(
        corrected_difference,
        overlap_mask
    )

    threshold = SIGNIFICANCE_SIGMA * global_sigma

    (
        positive_candidates,
        negative_candidates,
        candidate_regions
    ) = detect_candidate_regions(
        corrected_difference,
        overlap_mask,
        local_noise
    )

    candidate_mask = (
        positive_candidates | negative_candidates
    )

    # ---------------------------------------------------------
    # 7. Calculate candidate diagnostics.
    # ---------------------------------------------------------

    positive_count = int(
        np.count_nonzero(positive_candidates)
    )

    negative_count = int(
        np.count_nonzero(negative_candidates)
    )

    total_candidate_count = positive_count + negative_count

    positive_region_count = sum(
        region["polarity"] == "positive"
        for region in candidate_regions
    )

    negative_region_count = sum(
        region["polarity"] == "negative"
        for region in candidate_regions
    )

    difference_percentiles = np.percentile(
        valid_differences,
        [1, 5, 25, 50, 75, 95, 99]
    )

    candidate_diagnostics = {
        "positive_candidate_percentage": round(
            100.0 * positive_count / overlap_pixels,
            4
        ),
        "negative_candidate_percentage": round(
            100.0 * negative_count / overlap_pixels,
            4
        ),
        "total_candidate_percentage": round(
            100.0 * total_candidate_count / overlap_pixels,
            4
        ),
        "negative_to_positive_ratio": round(
            negative_count / max(positive_count, 1),
            2
        ),
        "positive_region_count": int(
            positive_region_count
        ),
        "negative_region_count": int(
            negative_region_count
        ),
        "difference_percentiles": {
            "p01": float(difference_percentiles[0]),
            "p05": float(difference_percentiles[1]),
            "p25": float(difference_percentiles[2]),
            "p50": float(difference_percentiles[3]),
            "p75": float(difference_percentiles[4]),
            "p95": float(difference_percentiles[5]),
            "p99": float(difference_percentiles[6]),
        }
    }

    print("\n--- SPHEREx Candidate Diagnostics ---")
    for key, value in candidate_diagnostics.items():
        print(f"{key}: {value}")
    print("------------------------------------\n")

    # ---------------------------------------------------------
    # 7A. Print the 10 largest negative candidate regions.
    # ---------------------------------------------------------

    largest_negative_regions = sorted(
        [
            region
            for region in candidate_regions
            if region["polarity"] == "negative"
        ],
        key=lambda region: region["area_pixels"],
        reverse=True
    )[:10]

    print("\n--- 10 Largest Negative Candidate Regions ---")

    if not largest_negative_regions:
        print("No negative candidate regions found.")

    image1_height, image1_width = image1.shape

    for index, region in enumerate(largest_negative_regions, start=1):

        px = region["peak_x"]
        py = region["peak_y"]

        # Original image 1 value and WCS-aligned image 2 value.
        value1 = float(image1[py, px])
        value2 = float(aligned_image2[py, px])

        raw_difference = value1 - value2
        corrected_value = float(
            corrected_difference[py, px]
        )

        # Quality flags at this exact peak pixel.
        flags_value1 = int(flags1[py, px])
        flags_value2 = int(aligned_flags2[py, px])

        active_flags1 = [
            name
            for name, bit in BAD_FLAGS.items()
            if flags_value1 & bit
        ]

        active_flags2 = [
            name
            for name, bit in BAD_FLAGS.items()
            if flags_value2 & bit
        ]

        # Distance from the peak to the nearest image boundary.
        boundary_distance = min(
            px,
            py,
            image1_width - 1 - px,
            image1_height - 1 - py
        )

        near_boundary = boundary_distance < 10

        print(
            f"\nRegion {index}: "
            f"Area={region['area_pixels']} pixels | "
            f"Center=({region['center_x']:.2f}, "
            f"{region['center_y']:.2f})"
        )

        print(
            f"  Peak pixel: ({px}, {py})"
        )

        print(
            f"  Image 1 value: {value1:.6f} | "
            f"Aligned image 2 value: {value2:.6f}"
        )

        print(
            f"  Raw difference: {raw_difference:.6f} | "
            f"Corrected difference: {corrected_value:.6f}"
        )

        print(
            f"  Noise at peak: {region['peak_noise']:.6f} | "
            f"Peak significance: "
            f"{region['peak_significance']:.2f} sigma"
        )

        print(
            f"  Image 1 flags: {flags_value1} "
            f"{active_flags1}"
        )

        print(
            f"  Image 2 flags: {flags_value2} "
            f"{active_flags2}"
        )

        print(
            f"  Distance to nearest image boundary: "
            f"{boundary_distance} pixels | "
            f"Near boundary (<10 px): {near_boundary}"
        )

    print("\n---------------------------------------------\n")

    # ---------------------------------------------------------
    # 8. Count individual quality flags.
    # ---------------------------------------------------------

    flag_counts = {}

    for flag_name, bit_value in BAD_FLAGS.items():

        flagged_in_either_image = (
            ((flags1 & bit_value) != 0)
            | ((aligned_flags2 & bit_value) != 0)
        )

        flag_counts[flag_name] = int(
            np.count_nonzero(
                base_overlap_mask & flagged_in_either_image
            )
        )

    # ---------------------------------------------------------
    # 9. Generate the difference-image visualization.
    # ---------------------------------------------------------

    display_limit = float(
        np.percentile(
            np.abs(valid_differences),
            99.5
        )
    )

    if not np.isfinite(display_limit) or display_limit <= 0:
        display_limit = 1.0

    fig, ax = plt.subplots(figsize=(8, 8))

    ax.imshow(
        corrected_difference,
        cmap="gray",
        origin="lower",
        vmin=-display_limit,
        vmax=display_limit
    )

    positive_overlay = np.ma.masked_where(
        ~positive_candidates,
        positive_candidates.astype(float)
    )

    ax.imshow(
        positive_overlay,
        cmap="autumn",
        origin="lower",
        alpha=0.8,
        vmin=0,
        vmax=1
    )

    negative_overlay = np.ma.masked_where(
        ~negative_candidates,
        negative_candidates.astype(float)
    )

    ax.imshow(
        negative_overlay,
        cmap="winter",
        origin="lower",
        alpha=0.8,
        vmin=0,
        vmax=1
    )

    for region in candidate_regions[:MAX_REPORTED_CANDIDATES]:
        ax.plot(
            region["center_x"],
            region["center_y"],
            marker="x",
            color="white",
            markersize=5
        )

    ax.set_title(
        "SPHEREx Difference Image — Candidate Changes"
    )

    ax.set_xlabel("Pixel")
    ax.set_ylabel("Pixel")

    buffer = BytesIO()

    fig.savefig(
        buffer,
        format="png",
        bbox_inches="tight"
    )

    plt.close(fig)

    difference_image = base64.b64encode(
        buffer.getvalue()
    ).decode("utf-8")

    # ---------------------------------------------------------
    # 10. Return analysis results.
    # ---------------------------------------------------------

    results = {
        "image1_shape": list(image1.shape),
        "image2_shape": list(image2.shape),

        "base_overlap_pixels": base_overlap_pixels,
        "overlap_pixels": overlap_pixels,

        "flags_available_image1": flags_available1,
        "flags_available_image2": flags_available2,

        "image1_flagged_pixels": int(
            np.count_nonzero(flagged_in_image1)
        ),

        "image2_flagged_pixels": int(
            np.count_nonzero(flagged_in_image2)
        ),

        "quality_excluded_pixels": quality_excluded_pixels,

        "flag_counts": flag_counts,

        "median_offset": median_offset,
        "mean_difference": mean_difference,
        "median_difference": median_difference,
        "std_difference": std_difference,

        "threshold": float(threshold),

        "noise_sigma": float(global_sigma),
        "significance_sigma": SIGNIFICANCE_SIGMA,

        "positive_candidate_pixels": positive_count,
        "negative_candidate_pixels": negative_count,

        "candidate_region_count": len(candidate_regions),

        "candidate_regions": candidate_regions[
            :MAX_REPORTED_CANDIDATES
        ],

        "candidate_diagnostics": candidate_diagnostics,

        "difference_image": difference_image
    }

    return results
