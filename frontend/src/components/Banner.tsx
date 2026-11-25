export function Banner({
  cached,
  synthetic,
}: {
  cached?: boolean;
  synthetic?: boolean;
}) {
  if (!cached && !synthetic) return null;
  return (
    <div className="banner" role="status">
      {cached && <span>Using cached demo data</span>}
      {synthetic && <span className="badge synth">SIMULATED / TEST DATA</span>}
      <span>SkyFlip does not claim to discover Planet X.</span>
    </div>
  );
}
