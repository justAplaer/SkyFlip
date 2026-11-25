import type { MotionSpeedInfo } from "../types";

export function SpeedCard({ speed, expert = false }: { speed: MotionSpeedInfo | null; expert?: boolean }) {
  if (!speed) return null;
  const total = speed.solar_speed_kms;
  const sideways = speed.tangential_velocity_kms;
  const radial = speed.radial_velocity_kms;
  const hasTotal = total != null && Number.isFinite(total);
  const hasSideways = sideways != null && Number.isFinite(sideways);
  const hasRadial = radial != null && Number.isFinite(radial);
  return (
    <section className="panel speed-card" aria-label="How fast is it?" data-testid="speed-card">
      <h2>How fast is it?</h2>
      {speed.name && <p className="hint">Target: <strong>{speed.name}</strong></p>}
      <p className="hint">Catalog-based motion relative to the Sun, independent of the images currently playing.</p>
      {hasTotal ? <>
        <p className="speed-headline" data-testid="speed-headline">About {Math.round(total)} km/s</p>
        <p>Estimated total space speed relative to the Sun ({Math.round(total * 3600).toLocaleString()} km/h).</p>
      </> : <>
        <p className="speed-headline" data-testid="speed-headline">{hasSideways ? `At least about ${Math.round(sideways)} km/s` : "Speed unavailable"}</p>
        <p>{hasSideways ? `Approximate lower bound relative to the Sun (${Math.round(sideways * 3600).toLocaleString()} km/h), based on sideways motion alone.` : "No verified sideways speed is available."} The radial component is not in this app's verified data, so the total speed is unknown.</p>
      </>}
      <ul className="speed-lines">
        <li>Sideways component: {hasSideways ? `about ${sideways.toFixed(1)} km/s` : "unavailable"}</li>
        <li>Radial component: {hasRadial ? `${Math.abs(radial).toFixed(1)} km/s ${radial < 0 ? "toward" : radial > 0 ? "away from" : "relative to"} the Sun` : "unavailable"}</li>
        <li>Angular proper motion: {speed.pm_total_arcsec_yr >= .1 ? speed.pm_total_arcsec_yr.toFixed(2) : speed.pm_total_arcsec_yr.toFixed(3)} arcseconds per year</li>
        {speed.distance_pc != null && speed.distance_ly != null && <li>Distance: about {speed.distance_pc.toFixed(2)} parsecs ({speed.distance_ly.toFixed(1)} light-years)</li>}
      </ul>
      {!hasTotal && hasSideways && <p className="hint">The sideways component is only one part of its motion; it is an approximate lower bound on total speed.</p>}
      <p className="hint">Total speed combines the sideways and radial components using the square root of their squared speeds. The catalog values are measured at different epochs; solar-system barycentric and heliocentric values are treated as approximately equivalent here.</p>
      {speed.radial_velocity_note && <p className="hint">{speed.radial_velocity_note}</p>}
      {speed.is_variable_control && <p className="hint">This variable star can change brightness; its speed is not derived from brightness changes.</p>}
      <p className="hint">Proper motion: {speed.pm_citation}. {speed.parallax_citation && <>Parallax: {speed.parallax_citation}.</>}</p>
      {speed.radial_velocity_citation && <p className="hint">Radial velocity: {speed.radial_velocity_url ? <a href={speed.radial_velocity_url} target="_blank" rel="noreferrer">{speed.radial_velocity_citation}</a> : speed.radial_velocity_citation}.</p>}
      {expert && <p className="hint">{speed.pm_uncertainty_note} {speed.tangential_velocity_note}</p>}
    </section>
  );
}
