import type { CutoutFrame } from "../types";

/** Plain-language one-line summary of the current frame, for the hobbyist layout. */
export function FrameStrip({ frame, source }: { frame?: CutoutFrame; source?: string }) {
  if (!frame) return <span className="hint">Pick a target to start.</span>;
  const date = frame.time_iso ? frame.time_iso.slice(0, 10) : `MJD ${frame.mjd.toFixed(1)}`;
  const um = frame.central_wavelength_um;
  const band = um ? `Infrared ${um.toFixed(2)} µm` : `Detector ${frame.detector}`;
  const live = source === "live";
  return (
    <span className="frame-strip-facts" data-testid="frame-strip">
      <span>{date}</span>
      <span title={`SPHEREx detector D${frame.detector}`}>{band}</span>
      <span
        className={`pill ${live ? "pill-live" : "pill-cached"}`}
        title={live ? "Fetched live from the NASA IRSA archive" : "Saved copy of real archive frames"}
      >
        {live ? "Live" : "Cached"}
      </span>
    </span>
  );
}
