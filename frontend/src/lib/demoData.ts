import type {
  ChangeMetric,
  ChangeReference,
  ChangeScoresResponse,
  CutoutFrame,
  CutoutsResponse,
} from "../types";

export async function loadDemoCutouts(targetId: string): Promise<CutoutsResponse | null> {
  try {
    const r = await fetch(`/demo-data/${targetId}/manifest.json`);
    if (!r.ok) return null;
    const man = await r.json();
    const scale = Number(man.pixel_scale_arcsec ?? 6.15) / 3600;
    const frames: CutoutFrame[] = (man.frames ?? []).map((f: Record<string, unknown>) => {
      const float_shape = f.float_shape as [number, number] | undefined;
      const image_shape =
        (f.image_shape as [number, number] | undefined) ?? float_shape;
      const ny = float_shape?.[0] ?? image_shape?.[0];
      const nx = float_shape?.[1] ?? image_shape?.[1];
      let wcs = f.wcs as Record<string, unknown> | undefined;
      if ((!wcs || Object.keys(wcs).length === 0) && nx && ny) {
        const cra = Number(f.cutout_center_ra ?? man.ra);
        const cdec = Number(f.cutout_center_dec ?? man.dec);
        wcs = {
          CRPIX1: (nx + 1) / 2,
          CRPIX2: (ny + 1) / 2,
          CRVAL1: cra,
          CRVAL2: cdec,
          CDELT1: -scale,
          CDELT2: scale,
          NAXIS1: nx,
          NAXIS2: ny,
          CTYPE1: "RA---TAN",
          CTYPE2: "DEC--TAN",
        };
      }
      return {
        epoch_id: String(f.epoch_id),
        obs_id: String(f.obs_id ?? ""),
        mjd: Number(f.mjd),
        time_iso: String(f.time_iso ?? ""),
        bandpass: String(f.bandpass ?? "SPHEREx-D1"),
        detector: Number(f.detector ?? 1),
        image_url: `/demo-data/${targetId}/${f.png}`,
        central_wavelength_um: f.central_wavelength_um as number | undefined,
        flag_summary: (f.flag_summary as Record<string, number>) ?? {},
        is_synthetic: Boolean(man.is_synthetic),
        float_bin: f.float_bin ? `/demo-data/${targetId}/${f.float_bin}` : undefined,
        float_shape,
        flags_bin: f.flags_bin ? `/demo-data/${targetId}/${f.flags_bin}` : undefined,
        bunit: (f.bunit as string | undefined) ?? "MJy/sr",
        collection: f.collection as string | undefined,
        native_dtype: (f.native_dtype as string | undefined) ?? "float32",
        png_unique_gray_levels: f.png_unique_gray_levels as number | undefined,
        cutout_url: f.cutout_url as string | undefined,
        image_shape,
        background_note:
          (man.background_note as string | undefined) ??
          "Cached IMAGE − ZODI (precache subtract_zodi=True). Archive IMAGE alone does not subtract ZODI.",
        png_display_assist: Boolean(f.png_display_assist),
        png_display_note: f.png_display_note as string | undefined,
        target_x_pix:
          f.predicted_x_pix != null
            ? Number(f.predicted_x_pix)
            : f.target_x_pix != null
              ? Number(f.target_x_pix)
              : undefined,
        target_y_pix:
          f.predicted_y_pix != null
            ? Number(f.predicted_y_pix)
            : f.target_y_pix != null
              ? Number(f.target_y_pix)
              : undefined,
        view_mode: "target_crop" as const,
        source_url: (f.cutout_url as string | undefined) ?? undefined,
        wcs,
      };
    });
    return {
      ra: man.ra,
      dec: man.dec,
      catalog_ra:
        man.catalog_ra != null && Number.isFinite(Number(man.catalog_ra))
          ? Number(man.catalog_ra)
          : undefined,
      catalog_dec:
        man.catalog_dec != null && Number.isFinite(Number(man.catalog_dec))
          ? Number(man.catalog_dec)
          : undefined,
      fov_deg: man.fov_deg ?? 0.2,
      frames,
      source: "cached-demo",
      view_mode: "target_crop",
      pixel_scale_arcsec: man.pixel_scale_arcsec ?? 6.15,
      note: "Using cached demo data — labeled cached, not live IRSA",
    };
  } catch {
    return null;
  }
}

/** Offline change scores from precomputed demo JSON (no backend required). */
export async function loadDemoChangeScores(
  targetId: string,
  opts: {
    ra: number;
    dec: number;
    radius: number;
    metric: ChangeMetric;
    reference: ChangeReference;
  },
): Promise<ChangeScoresResponse | null> {
  try {
    const r = await fetch(`/demo-data/${targetId}/change_scores.json`);
    if (!r.ok) return null;
    const cached = await r.json();
    const key = `${opts.metric}|${opts.reference}|${opts.radius}`;
    const payload = cached.by_key?.[key] ?? cached.default;
    if (!payload?.frames) return null;
    return {
      ra: opts.ra,
      dec: opts.dec,
      radius_pix: opts.radius,
      metric: opts.metric,
      reference: opts.reference,
      frames: payload.frames,
      motion: payload.motion ?? {},
      source: "cached-demo",
      pixel_scale_arcsec: 6.15,
      aperture_x_pix: payload.aperture_x_pix,
      aperture_y_pix: payload.aperture_y_pix,
      is_synthetic: Boolean(payload.is_synthetic),
      banner: "using cached demo data",
      metric_note:
        payload.note ??
        "Change = difference from reference in the aperture (candidates only).",
    };
  } catch {
    return null;
  }
}
