import type { MoverCandidate } from "../types";

export function CandidateList({
  movers,
  onSelect,
}: {
  movers: MoverCandidate[];
  onSelect?: (m: MoverCandidate) => void;
}) {
  return (
    <section className="panel" aria-label="Mover candidates">
      <h2>Candidates</h2>
      <p className="hint" role="note" data-testid="candidates-disclaimer">
        Candidates only. Not a discovery claim. Classifications use fitted motion with uncertainty
        and significance (≥3 epochs when available): known, candidate, or likely artifact.
      </p>
      <ul className="cand-list">
        {movers.length === 0 && <li>No movers loaded yet.</li>}
        {movers.map((m) => {
          const xm = m.crossmatch || {};
          const xmStatus = typeof xm.status === "string" ? xm.status : "";
          return (
            <li key={m.id}>
              <button type="button" onClick={() => onSelect?.(m)}>
                <strong>{m.id}</strong> · {m.classification}
                {m.classification === "known" && (
                  <span className="badge" data-testid="known-badge">
                    known
                  </span>
                )}
                {xmStatus === "unavailable" && (
                  <span className="badge" data-testid="not-crossmatched-badge">
                    not cross-matched
                  </span>
                )}
                {xmStatus === "cached" && (
                  <span className="badge" data-testid="crossmatch-cached-badge">
                    cached
                  </span>
                )}
                {m.is_synthetic && <span className="badge synth">SIMULATED</span>}
              </button>
              <div className="hint">
                μ_α={m.pm_ra_arcsec_yr?.toFixed(1) ?? "n/a"}±
                {m.pm_ra_err_arcsec_yr?.toFixed(1) ?? "no σ"} ″/yr; μ_δ=
                {m.pm_dec_arcsec_yr?.toFixed(1) ?? "n/a"}±
                {m.pm_dec_err_arcsec_yr?.toFixed(1) ?? "no σ"} ″/yr
              </div>
              {typeof xm.name === "string" && (
                <div className="hint" data-testid="crossmatch-ref">
                  cross-match: {xm.name}
                  {typeof xm.catalog === "string" ? ` · ${xm.catalog}` : ""}
                  {typeof xm.separation_arcsec === "number"
                    ? ` · sep ${xm.separation_arcsec.toFixed(2)}″`
                    : ""}
                  {xmStatus ? ` · ${xmStatus}` : ""}
                </div>
              )}
              {xmStatus === "unavailable" && (
                <div className="hint">
                  catalogue lookup unavailable — unverified candidate (not cross-matched)
                </div>
              )}
              <div className="hint">{m.reasons.join("; ")}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
