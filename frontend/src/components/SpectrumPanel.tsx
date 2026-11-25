import { useMemo } from "react";
import type { SpectrumPoint } from "../types";

/** Published IR absorption band positions for annotation only — cite in SCIENCE_LIMITS.md */
const BANDS = [
  { name: "H₂O", lo: 2.7, hi: 3.5 },
  { name: "CO₂", lo: 4.1, hi: 4.4 },
  { name: "CO", lo: 4.5, hi: 4.8 },
];

export function SpectrumPanel({
  points,
  methodNote,
}: {
  points: SpectrumPoint[];
  methodNote?: string;
}) {
  const path = useMemo(() => {
    if (!points.length) return "";
    const w = points.map((p) => p.wavelength_um);
    const f = points.map((p) => p.flux);
    const w0 = Math.min(...w);
    const w1 = Math.max(...w);
    const f0 = Math.min(...f);
    const f1 = Math.max(...f);
    return points
      .map((p, i) => {
        const x = ((p.wavelength_um - w0) / (w1 - w0 || 1)) * 400 + 20;
        const y = 180 - ((p.flux - f0) / (f1 - f0 || 1)) * 140;
        return `${i === 0 ? "M" : "L"}${x},${y}`;
      })
      .join(" ");
  }, [points]);

  return (
    <section className="panel" aria-label="Spectrum">
      <h2>Spectrum on click</h2>
      <p className="hint">
        Display only — we do not classify object type from the spectrum. Absorption regions marked from
        published band positions (see docs/SCIENCE_LIMITS.md).
      </p>
      {!points.length ? (
        <p>
          Click Load spectrum. Point count depends on available exposures — we only call it “102
          bands” if we actually have 102 wavelength samples (All-Sky Cube / full LVF coverage).
        </p>
      ) : (
        <p className="hint" role="status">
          Plotting <strong>{points.length}</strong> wavelength sample
          {points.length === 1 ? "" : "s"}
          {points.length < 102
            ? " — not a full 102-band SPHEREx spectrum"
            : " (full 102-band coverage)"}
          . {methodNote}
        </p>
      )}
      {points.length > 0 && (
        <svg viewBox="0 0 440 200" role="img" aria-label="Flux versus wavelength">
          <rect x="0" y="0" width="440" height="200" fill="#0c1528" />
          {BANDS.map((b) => (
            <g key={b.name}>
              <rect
                x={20 + ((b.lo - 0.75) / 4.25) * 400}
                y="20"
                width={((b.hi - b.lo) / 4.25) * 400}
                height="160"
                fill="rgba(80,180,200,0.12)"
              />
              <text x={24 + ((b.lo - 0.75) / 4.25) * 400} y="36" fill="#8fd0e0" fontSize="10">
                {b.name}
              </text>
            </g>
          ))}
          <path d={path} stroke="#f0c24b" fill="none" strokeWidth="2" />
          {points.map((p) => {
            if (p.flux_err == null) return null;
            const w0 = Math.min(...points.map((x) => x.wavelength_um));
            const w1 = Math.max(...points.map((x) => x.wavelength_um));
            const f0 = Math.min(...points.map((x) => x.flux));
            const f1 = Math.max(...points.map((x) => x.flux));
            const x = ((p.wavelength_um - w0) / (w1 - w0 || 1)) * 400 + 20;
            const y = 180 - ((p.flux - f0) / (f1 - f0 || 1)) * 140;
            const dy = (p.flux_err / (f1 - f0 || 1)) * 140;
            return (
              <line key={p.wavelength_um} x1={x} x2={x} y1={y - dy} y2={y + dy} stroke="#aac" />
            );
          })}
        </svg>
      )}
      <p className="hint">{methodNote}</p>
    </section>
  );
}
