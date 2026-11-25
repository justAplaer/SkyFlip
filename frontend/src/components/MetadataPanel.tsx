import { useEffect, useState } from "react";
import type { CutoutFrame, FramePyramidMeta } from "../types";
import {
  formatEpochUtc,
  fovFromShape,
  readJsonPref,
  shortenArchiveUrl,
  writeJsonPref,
} from "../lib/panelPrefs";

const SECTION_KEY = "skyflip.dataPanel.sections";

type Sections = {
  observation: boolean;
  image: boolean;
  display: boolean;
  flags: boolean;
};

const DEFAULT_SECTIONS: Sections = {
  observation: true,
  image: false,
  display: false,
  flags: false,
};

export function MetadataPanel({
  frame,
  source,
  fovDeg,
  pixelScaleArcsec = 6.15,
  subtractZodi,
  viewMode,
  frameMeta,
  stretchLimits,
  showFlags,
  onShowFlags,
  alignmentNote,
}: {
  frame?: CutoutFrame;
  source?: string;
  fovDeg?: number;
  pixelScaleArcsec?: number;
  subtractZodi?: boolean;
  viewMode?: string;
  frameMeta?: FramePyramidMeta | null;
  stretchLimits?: { lo: number; hi: number; mode: string } | null;
  showFlags?: boolean;
  onShowFlags?: (on: boolean) => void;
  /** Optional Gaia alignment proof line from overlays. */
  alignmentNote?: string | null;
}) {
  const [sections, setSections] = useState<Sections>(() =>
    readJsonPref(SECTION_KEY, DEFAULT_SECTIONS),
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    writeJsonPref(SECTION_KEY, sections);
  }, [sections]);

  if (!frame) {
    return (
      <aside className="panel data-panel" aria-label="Data provenance">
        <h2>Data</h2>
        <p className="hint">No frame selected.</p>
      </aside>
    );
  }

  const flags = frame.flag_summary ?? {};
  const totalPix =
    typeof flags.total_pixels === "number" && flags.total_pixels > 0
      ? flags.total_pixels
      : undefined;
  const flagRows = Object.entries(flags)
    .filter(([k, v]) => k !== "total_pixels" && k !== "any_flagged" && Number(v) > 0)
    .map(([k, v]) => ({
      name: k,
      count: Number(v),
      pct: totalPix ? (100 * Number(v)) / totalPix : null,
    }))
    .sort((a, b) => b.count - a.count);

  const shape =
    frame.array_shape ??
    (frameMeta ? [frameMeta.naxis2, frameMeta.naxis1] : undefined) ??
    frame.float_shape ??
    frame.image_shape;
  const archiveUrl =
    frame.source_url ?? frame.cutout_url ?? frameMeta?.source_url ?? null;
  const live = source === "live";
  const cached = source === "cached-demo";
  const mode = viewMode ?? frame.view_mode ?? "target_crop";
  const zodiOn = subtractZodi ?? frame.subtract_zodi ?? false;
  const fov = fovFromShape(shape as number[] | undefined, pixelScaleArcsec, mode, fovDeg);

  const pixelsNote =
    mode === "full_frame" || frame.frame_meta_url
      ? "Pixels streamed as float32 tiles from the server"
      : frame.float_bin
        ? "Cached float32 pack"
        : "Display PNG (float pack not attached)";

  const backgroundSentence = zodiOn
    ? "Zodiacal light (ZODI) has been subtracted from the archive IMAGE."
    : "Raw archive IMAGE. Zodiacal light is not subtracted.";

  const copyUrl = async () => {
    if (!archiveUrl) return;
    try {
      await navigator.clipboard.writeText(archiveUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className="panel data-panel" aria-label="Data provenance">
      <h2>Data</h2>

      <div className="status-pills" role="status" aria-label="Data status">
        <span className={`pill ${live ? "pill-live" : "pill-cached"}`}>
          {live ? "LIVE IRSA" : cached ? "CACHED" : String(source ?? "—").toUpperCase()}
        </span>
        <span className="pill pill-neutral">
          {mode === "full_frame" ? "Full frame" : "Target crop"}
        </span>
        <span className="pill pill-neutral">ZODI {zodiOn ? "on" : "off"}</span>
        <span className="pill pill-neutral">D{frame.detector}</span>
      </div>

      <details
        className="data-section"
        open={sections.observation}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          setSections((s) => ({ ...s, observation: open }));
        }}
      >
        <summary>Observation</summary>
        <dl className="meta-grid">
          <dt>Obs ID</dt>
          <dd className="mono">{frame.obs_id || "—"}</dd>
          <dt>Collection</dt>
          <dd>{frame.collection ?? frameMeta?.collection ?? "—"}</dd>
          <dt>Epoch</dt>
          <dd>{formatEpochUtc(frame.time_iso, frame.mjd)}</dd>
          <dt>Detector</dt>
          <dd className="mono">
            D{frame.detector} · {frame.bandpass}
          </dd>
          <dt>Wavelength</dt>
          <dd className="mono">
            {frame.central_wavelength_um != null
              ? `${Number(frame.central_wavelength_um).toFixed(3)} µm`
              : "unknown"}
          </dd>
        </dl>
        {archiveUrl && (
          <div className="archive-url-row">
            <a
              className="archive-url mono"
              href={archiveUrl}
              target="_blank"
              rel="noreferrer"
              title={archiveUrl}
            >
              {shortenArchiveUrl(archiveUrl)}
            </a>
            <button type="button" className="btn-compact" onClick={() => void copyUrl()}>
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              className="btn-compact linkish"
              href={archiveUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open
            </a>
          </div>
        )}
        <p className="verified-badge" title="The float IMAGE extension is shown without resampling to a new grid.">
          Verified · Pixels come directly from the IRSA file above, not resampled.
        </p>
      </details>

      <details
        className="data-section"
        open={sections.image}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          setSections((s) => ({ ...s, image: open }));
        }}
      >
        <summary>Image</summary>
        <dl className="meta-grid">
          <dt>Array</dt>
          <dd className="mono">
            {shape
              ? `${shape[0]} × ${shape[1]}, ${frame.native_dtype ?? "float32"}`
              : "unknown"}
          </dd>
          <dt>Pixel scale</dt>
          <dd className="mono">{pixelScaleArcsec}″ / pixel</dd>
          <dt>FOV</dt>
          <dd>{fov.label}</dd>
          <dt>Units</dt>
          <dd className="mono">{frame.bunit ?? frameMeta?.bunit ?? "MJy/sr"}</dd>
          <dt>Pyramid</dt>
          <dd>
            {frameMeta
              ? `${frameMeta.n_levels} levels · tile ${frameMeta.tile_size}px`
              : "n/a (crop)"}
          </dd>
          <dt>Pixels</dt>
          <dd>{pixelsNote}</dd>
        </dl>
      </details>

      <details
        className="data-section"
        open={sections.display}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          setSections((s) => ({ ...s, display: open }));
        }}
      >
        <summary>Display</summary>
        <dl className="meta-grid">
          <dt>Stretch</dt>
          <dd>
            {stretchLimits
              ? `${stretchLimits.mode}, ${stretchLimits.lo.toFixed(2)} to ${stretchLimits.hi.toFixed(2)} ${frame.bunit ?? "MJy/sr"}`
              : "asinh (display only)"}
          </dd>
          <dt>ZODI</dt>
          <dd>{zodiOn ? "on" : "off"}</dd>
          <dt>Background</dt>
          <dd>
            {backgroundSentence}{" "}
            <span className="learn-more" title="See docs/DATA_NOTES.md in the SkyFlip repository">
              Learn more
            </span>
          </dd>
        </dl>
        {alignmentNote && (
          <p className="hint" data-testid="alignment-note">
            {alignmentNote}
          </p>
        )}
      </details>

      <details
        className="data-section"
        open={sections.flags}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          setSections((s) => ({ ...s, flags: open }));
        }}
      >
        <summary>Contamination / quality flags</summary>
        <div className="flags-controls">
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(showFlags)}
              onChange={(e) => onShowFlags?.(e.target.checked)}
            />
            Show flagged pixels
          </label>
          <p className="hint">
            Overlay marks bad FLAGS bits (display only; data unchanged).
          </p>
        </div>
        {flagRows.length === 0 ? (
          <p className="flags-ok" role="status">
            <span aria-hidden>✓</span> No flagged pixels in this view
          </p>
        ) : (
          <div className="flag-chips" role="list">
            {flagRows.map((f) => (
              <span key={f.name} className="flag-chip" role="listitem">
                <span className="mono">{f.name}</span>{" "}
                <strong className="mono">{f.count}</strong>
                {f.pct != null ? (
                  <span className="muted"> ({f.pct.toFixed(1)}%)</span>
                ) : null}
              </span>
            ))}
          </div>
        )}
      </details>
    </aside>
  );
}
