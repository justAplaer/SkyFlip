import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import {
  formatCoordBox,
  normalizeRa,
  parseCoord,
  validateSkyCoord,
} from "../lib/parseCoord";

export {
  normalizeRa,
  parseCoord,
  validateSkyCoord,
  formatCoordBox,
  galacticToIcrs,
} from "../lib/parseCoord";

interface Props {
  onGoto: (ra: number, dec: number, name?: string) => void;
  /** Keep the box in sync when a preset button (or click-to-fill) sets coords. */
  value?: string;
}

export function SearchBar({ onGoto, value }: Props) {
  const [q, setQ] = useState(value ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (value != null && value !== q) setQ(value);
    // Only sync from parent; don't fight typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const parsed = parseCoord(q);
    if (parsed) {
      const ra = normalizeRa(parsed.ra);
      const bad = validateSkyCoord(ra, parsed.dec);
      if (bad) {
        setErr(bad);
        return;
      }
      onGoto(ra, parsed.dec);
      return;
    }
    if (!q.trim()) {
      setErr("Enter coordinates or an object name.");
      return;
    }
    // Reject obvious non-name garbage that failed parse (e.g. "99:99:99 1:2:3")
    if (/^\d/.test(q.trim()) || /^[+-]?\d/.test(q.trim()) || /^gal\s*:/i.test(q.trim())) {
      setErr(
        "Couldn’t parse coordinates — try degrees (133.8, -7.25), colons (08:55:10.831 -07:14:42.53), sexagesimal (08h55m10.8s -7d14m42.5s), or gal: l b.",
      );
      return;
    }
    setBusy(true);
    try {
      const r = await api.resolve(q);
      const ra = normalizeRa(r.ra);
      const bad = validateSkyCoord(ra, r.dec);
      if (bad) {
        setErr(bad);
        return;
      }
      onGoto(ra, r.dec, r.name);
    } catch (ex) {
      const raw = ex instanceof Error ? ex.message : String(ex);
      setErr(
        /404|not found|unknown/i.test(raw)
          ? `Couldn’t resolve “${q.trim()}” — try degrees, colons, or another name.`
          : raw.includes("Failed to fetch") || /network|abort/i.test(raw)
            ? "Name resolve unavailable (network). Try coordinates instead."
            : `Couldn’t parse or resolve — try degrees, colons (08:55:10.831 -07:14:42.53), or a name. (${raw})`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="search" onSubmit={submit} aria-label="Sky search">
      <label htmlFor="sky-q">Coordinates or name</label>
      <div className="row">
        <input
          id="sky-q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (err) setErr("");
          }}
          placeholder="RA, Dec or object name"
          aria-describedby="sky-help"
          aria-invalid={err ? true : undefined}
        />
        <button type="submit" disabled={busy}>
          {busy ? "…" : "Go"}
        </button>
      </div>
      <details className="coordinate-guide" id="sky-help">
        <summary>How to enter coordinates</summary>
        <p>Enter right ascension first, then declination. Choose a format:</p>
        <ul><li>Degrees: <code>133.795129, -7.245147</code></li><li>Hours, minutes, seconds: <code>08:55:10.831 -07:14:42.53</code></li><li>Letters: <code>08h55m10.831s -7d14m42.53s</code></li></ul>
        <p>RA uses hours (0–23); declination uses degrees (−90 to +90). Include the minus sign for southern declinations. You can also search by object name or choose a target preset.</p>
      </details>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

/** Convenience for parents that only have numbers. */
export function coordBoxFromRaDec(ra: number, dec: number): string {
  return formatCoordBox(ra, dec);
}
