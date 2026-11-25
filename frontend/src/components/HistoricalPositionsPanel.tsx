import type { HistoricalMarker, MissingMarker, ProperMotionInfo } from "../types";

export function HistoricalPositionsPanel({
  properMotion,
  pmMethod,
  historicalMarkers,
  missingMarkers,
  targetId,
}: {
  properMotion: ProperMotionInfo | null;
  pmMethod?: string;
  historicalMarkers: HistoricalMarker[];
  missingMarkers: MissingMarker[];
  targetId?: string;
}) {
  const mu =
    properMotion != null
      ? Math.hypot(
          Number(properMotion.pm_ra_cosdec_arcsec_yr) || 0,
          Number(properMotion.pm_dec_arcsec_yr) || 0,
        )
      : 0;
  const noPm =
    !properMotion ||
    mu < 0.05 ||
    /variable|no proper motion/i.test(
      `${properMotion.citation ?? ""} ${properMotion.uncertainty_note ?? ""}`,
    ) ||
    targetId === "r_draconis" ||
    targetId === "rw_aurigae";

  const shownMissing = missingMarkers.filter(
    (m) => m.reason && !/not available$/i.test(m.reason.trim()),
  );
  // Prefer cards that have a concrete status; skip empty "not available" noise
  const catalogCards = [
    ...historicalMarkers.map((m) => ({
      id: m.id,
      label: m.label,
      ok: true,
      line: `Epoch ${m.epoch}. ${m.epoch_note}${m.uncertainty_note ? ` ${m.uncertainty_note}` : ""}`,
    })),
    ...shownMissing.map((m) => ({
      id: m.id,
      label: m.label,
      ok: false,
      line: m.reason,
    })),
  ].filter((c) => c.line && !/^not (shown|available)/i.test(c.line.trim()));

  if (
    !properMotion &&
    historicalMarkers.length === 0 &&
    missingMarkers.length === 0
  ) {
    return null;
  }

  return (
    <section className="panel hist-panel" aria-label="Historical position overlay">
      <h2>Historical positions</h2>

      <div className="hist-legend" aria-label="Legend">
        <span>
          <span className="dot cyan" aria-hidden /> Cyan cross — catalog epoch
        </span>
        <span>
          <span className="dot yellow" aria-hidden /> Yellow ring — predicted at this visit
        </span>
      </div>

      {noPm ? (
        <p className="hint" data-testid="no-pm-note">
          No proper motion on record (treated as a variable star, not a mover).
        </p>
      ) : (
        properMotion && (
          <table className="pm-table">
            <caption className="sr-only">Proper motion</caption>
            <tbody>
              <tr>
                <th scope="row">PM RA (μα*)</th>
                <td className="mono">
                  {Number(properMotion.pm_ra_cosdec_arcsec_yr).toFixed(3)}″/yr
                </td>
              </tr>
              <tr>
                <th scope="row">PM Dec (μδ)</th>
                <td className="mono">
                  {Number(properMotion.pm_dec_arcsec_yr).toFixed(3)}″/yr
                </td>
              </tr>
              <tr>
                <th scope="row">Catalog epoch</th>
                <td className="mono">{String(properMotion.ref_epoch)}</td>
              </tr>
              <tr>
                <th scope="row">Source</th>
                <td>{properMotion.citation}</td>
              </tr>
              <tr>
                <th scope="row">Uncertainty</th>
                <td>{properMotion.uncertainty_note}</td>
              </tr>
            </tbody>
          </table>
        )
      )}

      <p
        className="hint method-line"
        title="Astropy SkyCoord.apply_space_motion propagates the catalog position to each SPHEREx visit MJD."
      >
        Method: catalog position propagated to this visit
        {pmMethod ? ` · ${pmMethod}` : ""}. Not a detection claim.
      </p>

      {catalogCards.length > 0 && (
        <ul className="hist-cards">
          {catalogCards.map((c) => (
            <li key={c.id} className={`hist-card ${c.ok ? "ok" : "miss"}`}>
              <span className="hist-status" aria-hidden>
                {c.ok ? "●" : "○"}
              </span>
              <div>
                <strong>{c.label}</strong>
                <p className="hint">{c.line}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
