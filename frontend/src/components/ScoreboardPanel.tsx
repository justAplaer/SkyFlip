import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { LimitsPanel } from "./LimitsPanel";

function roundNice(v: unknown, digits = 0): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number" && Number.isFinite(v)) {
    return digits === 0 ? String(Math.round(v)) : v.toFixed(digits);
  }
  return "—";
}

export function ScoreboardPanel() {
  const [data, setData] = useState<{
    results: Record<string, unknown>;
    explanation: string;
    source: string;
  } | null>(null);
  const [err, setErr] = useState("");
  const [cachedBanner, setCachedBanner] = useState(false);
  const computedAt = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    api
      .scoreboard()
      .then(setData)
      .catch(async () => {
        try {
          const r = await fetch("/demo-data/scoreboard.json");
          if (!r.ok) throw new Error("scoreboard unavailable");
          const results = await r.json();
          setCachedBanner(true);
          setData({
            results,
            explanation:
              "Using cached demo scoreboard.json (API unreachable). Candidates only — not a discovery claim.",
            source: "cached-demo",
          });
        } catch (e) {
          setErr(String(e));
        }
      });
  }, []);

  const field = (data?.results?.field_validation ?? {}) as Record<string, unknown>;
  const selfTest = (data?.results?.motion_fit_self_test ?? {}) as Record<string, unknown>;
  const synth = (data?.results?.synthetic ?? {}) as Record<string, unknown>;
  const status = String(field.status ?? "");
  const example = status === "not computed yet" || !data;

  return (
    <section className="panel" aria-label="Validation scoreboard">
      <h2>Validation</h2>
      {err && <p className="error">{err}</p>}
      <div className="status-pills" role="status">
        <span className={`pill ${cachedBanner || data?.source === "cached-demo" ? "pill-cached" : "pill-live"}`}>
          {cachedBanner || data?.source === "cached-demo" ? "CACHED" : data ? "LIVE" : "…"}
        </span>
        <span className="pill pill-neutral">Computed {computedAt}</span>
        {example && <span className="pill pill-neutral">example / pending</span>}
      </div>
      <p className="hint">
        How often SkyFlip recovers known high–proper-motion objects in the demo fields, versus
        false candidates. Candidates only — not a discovery claim.
      </p>

      {!data ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="score-hero">
            <div>
              <div className="num">{roundNice(field.n_recovered)}</div>
              <div className="hint">movers recovered</div>
            </div>
            <div>
              <div className="num">{roundNice(field.n_missed)}</div>
              <div className="hint">missed</div>
            </div>
            <div>
              <div className="num">{roundNice(field.n_false_candidates)}</div>
              <div className="hint">false candidates</div>
            </div>
            <div>
              <div className="num">
                {typeof field.recovery_rate === "number"
                  ? `${Math.round(field.recovery_rate * 100)}%`
                  : "—"}
              </div>
              <div className="hint">recovery rate</div>
            </div>
          </div>

          <p className="hint">
            Method: {String(field.method ?? data.explanation)}. Data source: {data.source}.
          </p>

          <LimitsPanel />

          <details>
            <summary>Per-target measurements</summary>
            <pre className="hint">
              {JSON.stringify(field.per_target ?? [], null, 2)}
            </pre>
          </details>
          <details>
            <summary>Mover misses</summary>
            <p className="hint">{String(field.misses_explained ?? field.note ?? "")}</p>
            <pre className="hint">{JSON.stringify(field.misses ?? [], null, 2)}</pre>
          </details>
          <details>
            <summary>Synthetic injection (SIMULATED)</summary>
            <p className="badge synth" role="status">
              SIMULATED / TEST DATA
            </p>
            <p className="hint">{String(synth.method ?? synth.note ?? "")}</p>
            <pre className="hint">{JSON.stringify(synth.bins ?? [], null, 2)}</pre>
          </details>
          <details>
            <summary>Motion-fit self-test</summary>
            <p className="hint">
              Synthetic track recovered: {selfTest.ok ? "yes" : "no"}. Truth μ≈
              {roundNice(selfTest.truth_pm_ra, 1)}/{roundNice(selfTest.truth_pm_dec, 1)} ″/yr;
              fit {roundNice(selfTest.fit_pm_ra, 1)}/{roundNice(selfTest.fit_pm_dec, 1)} ″/yr.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
