export function AboutPanel() {
  return (
    <section className="panel about-panel" aria-label="About SkyFlip">
      <h2>About</h2>
      <h3>What is SPHEREx?</h3>
      <p>
        SPHEREx is NASA’s near-infrared all-sky spectral survey. It maps the whole sky in many
        wavelength bands so each sky patch is visited over time.
      </p>
      <h3>What SkyFlip does</h3>
      <p>
        SkyFlip is a blink comparator for SPHEREx: enter RA/Dec (or pick a demo target) and flip
        through real IRSA frames of that patch like a short video. Motion between visits is a
        <em> candidate</em> only.
      </p>
      <h3>How to use it (3 steps)</h3>
      <ol>
        <li>Pick one of the five demo targets, or type coordinates / a name.</li>
        <li>Press ▶ Blink and watch for a dot that jumps between visits.</li>
        <li>Open “Show provenance” under the image, or turn on Scientist details, for the evidence.</li>
      </ol>
      <h3 id="glossary">Glossary</h3>
      <dl className="meta-grid glossary">
        <dt>ZODI</dt>
        <dd>Zodiacal light — sunlight scattered by dust in the solar system.</dd>
        <dt>MJy/sr</dt>
        <dd>MegaJansky per steradian — surface brightness units of SPHEREx IMAGE.</dd>
        <dt>Ghost track</dt>
        <dd>Predicted position of a moving object at each visit (proper motion).</dd>
        <dt>WCS</dt>
        <dd>World Coordinate System — maps pixels ↔ sky (RA/Dec).</dd>
        <dt>Difference image</dt>
        <dd>One epoch minus another; static sky cancels, movers remain.</dd>
      </dl>
      <h3>Credits</h3>
      <p>
        Data: NASA / JPL-Caltech / IPAC SPHEREx archive (IRSA). Catalogs: Gaia, WISE / CatWISE.
        Libraries: Astropy, Aladin Lite when enabled. MIT license.
      </p>
      <p className="hint" role="note">
        SkyFlip does not claim to discover Planet X.
      </p>
    </section>
  );
}
