import type { PixelInspectResult } from "../lib/api";

export function PixelInspectorPanel({
  result,
  busy,
  err,
  hint,
}: {
  result: PixelInspectResult | null;
  busy?: boolean;
  err?: string;
  hint?: string;
}) {
  return (
    <aside className="panel" aria-label="Scientific pixel inspector">
      <h2>Pixel inspector</h2>
      <p className="hint">
        {hint ??
          "Click the blink image (Expert) to read IMAGE + FLAGS at that pixel. Shift+click also works while picking an aperture."}
      </p>
      {busy && (
        <p className="hint" role="status">
          Reading pixel…
        </p>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {!result && !busy && !err && (
        <p className="hint">No pixel selected yet.</p>
      )}
      {result && (
        <dl>
          <dt>Target / epoch</dt>
          <dd className="mono break">
            {result.target_id} · {result.epoch_id}
          </dd>
          <dt>Pixel</dt>
          <dd className="mono">
            x={result.x_pix}, y={result.y_pix}
          </dd>
          <dt>IMAGE</dt>
          <dd className="mono">
            {result.image_mjy_sr != null
              ? `${result.image_mjy_sr.toPrecision(6)} ${result.bunit}`
              : "not computed"}
          </dd>
          <dt>FLAGS</dt>
          <dd className="mono">
            {result.flags_raw != null ? (
              <>
                raw={result.flags_raw}
                {result.flags_set.length > 0
                  ? ` · ${result.flags_set.join(", ")}`
                  : " · (no bits set)"}
              </>
            ) : (
              "not available on this frame"
            )}
          </dd>
          <dt>λ (frame central)</dt>
          <dd>
            {result.central_wavelength_um != null
              ? `${result.central_wavelength_um.toFixed(4)} µm`
              : "not computed"}
            <span className="hint"> — {result.wavelength_note}</span>
          </dd>
          <dt>VARIANCE</dt>
          <dd className="hint">
            {result.variance != null ? String(result.variance) : result.variance_note}
          </dd>
          <dt>ZODI</dt>
          <dd className="hint">
            {result.zodi_mjy_sr != null ? String(result.zodi_mjy_sr) : result.zodi_note}
          </dd>
          {result.note && (
            <>
              <dt>Note</dt>
              <dd className="hint">{result.note}</dd>
            </>
          )}
        </dl>
      )}
    </aside>
  );
}
