/** Client-side display stretch for float SPHEREx cutouts. Display only — never mutates data. */

export type StretchMode = "linear" | "log" | "asinh";
export type Colormap = "gray" | "gray_inv" | "viridis";

/** SPHEREx FLAGS bit indices (Explanatory Supplement / docs/DATA_NOTES.md). */
export const FLAG_BITS: Record<string, number> = {
  TRANSIENT: 0,
  OVERFLOW: 1,
  SUR_ERROR: 2,
  NONFUNC: 6,
  DICHROIC: 7,
  MISSING_DATA: 9,
  HOT: 10,
  COLD: 11,
  FULLSAMPLE: 12,
  PHANMISS: 14,
  NONLINEAR: 15,
  PERSIST: 17,
  OUTLIER: 19,
  SOURCE: 21,
  GHOST: 22,
  GHOST_FPA: 23,
  GHOST_EXT: 24,
  STREAK: 25,
  BLOOM: 26,
  SNOWBALL: 27,
  HALO: 28,
  SATELLITE_HALO: 29,
};

/**
 * Contamination / quality bits drawn when "Show flagged pixels" is on.
 * SOURCE / FULLSAMPLE stay informational (never hatched). See SCIENCE_LIMITS.md.
 */
export const BAD_FLAG_NAMES = [
  "TRANSIENT",
  "OVERFLOW",
  "SUR_ERROR",
  "NONFUNC",
  "DICHROIC",
  "MISSING_DATA",
  "HOT",
  "COLD",
  "PHANMISS",
  "NONLINEAR",
  "PERSIST",
  "OUTLIER",
  "GHOST",
  "GHOST_FPA",
  "GHOST_EXT",
  "STREAK",
  "BLOOM",
  "SNOWBALL",
  "HALO",
  "SATELLITE_HALO",
] as const;

export type BadFlagName = (typeof BAD_FLAG_NAMES)[number];

export const BAD_FLAG_MASK: number = BAD_FLAG_NAMES.reduce(
  (m, name) => m | (1 << FLAG_BITS[name]),
  0,
);

/** Saturation / bloom — Explanatory Supplement Table 16 bits 1 and 26. */
export const SATURATION_FLAG_MASK =
  (1 << FLAG_BITS.OVERFLOW) | (1 << FLAG_BITS.BLOOM);

export function isBadFlag(flag: number): boolean {
  return (flag & BAD_FLAG_MASK) !== 0;
}

export function isSaturatedFlag(flag: number): boolean {
  return (flag & SATURATION_FLAG_MASK) !== 0;
}

/** Human-readable legend lines for the hatch overlay (bit index + name). */
export function flaggedPixelLegend(): { bit: number; name: string }[] {
  return BAD_FLAG_NAMES.map((name) => ({ bit: FLAG_BITS[name], name }));
}

export function percentileClip(data: Float32Array, lo: number, hi: number): [number, number] {
  const finite: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v)) finite.push(v);
  }
  if (!finite.length) return [0, 1];
  finite.sort((a, b) => a - b);
  const at = (p: number) =>
    finite[Math.min(finite.length - 1, Math.floor((p / 100) * finite.length))];
  const vmin = at(lo);
  const vmax = at(hi);
  if (vmax <= vmin) return [vmin, vmin + 1e-6];
  return [vmin, vmax];
}

/** Approximate viridis (colorblind-safe) — 6 control points, linear RGB lerp. */
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function sampleViridis(t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(i + 1, VIRIDIS.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function applyColormap(y: number, cmap: Colormap): [number, number, number] {
  const t = Math.min(Math.max(y, 0), 1);
  if (cmap === "gray_inv") {
    const g = Math.round((1 - t) * 255);
    return [g, g, g];
  }
  if (cmap === "viridis") return sampleViridis(t);
  const g = Math.round(t * 255);
  return [g, g, g];
}

/** Magenta hatch for bad/NaN — only when showFlags is on. */
function hatchRgba(i: number, width: number): [number, number, number, number] {
  const x = i % width;
  const y = Math.floor(i / width);
  const hatch = (x + y) % 4 === 0;
  return hatch ? [180, 60, 160, 220] : [48, 36, 56, 200];
}

const BLACK: [number, number, number, number] = [0, 0, 0, 255];

/**
 * Stretch float IMAGE to RGBA for canvas display.
 * - Default (showFlags=false): archive look — grayscale; NaN and OVERFLOW/BLOOM → plain black; no hatch.
 * - showFlags=true: purple hatch on BAD_FLAG_MASK pixels and NaN (SOURCE not hatched).
 */
export function stretchToRgba(
  data: Float32Array,
  width: number,
  height: number,
  opts: {
    mode: StretchMode;
    vmin: number;
    vmax: number;
    flags?: Uint16Array | Int16Array | null;
    colormap?: Colormap;
    /** When true, draw purple hatch on bad FLAGS / NaN. Default false (archive look). */
    showFlags?: boolean;
  },
): ImageData {
  const { mode, vmin, vmax, flags } = opts;
  const cmap = opts.colormap ?? "gray";
  const showFlags = Boolean(opts.showFlags);
  const out: { data: Uint8ClampedArray; width: number; height: number } =
    typeof ImageData !== "undefined"
      ? new ImageData(width, height)
      : { data: new Uint8ClampedArray(width * height * 4), width, height };
  const span = Math.max(vmax - vmin, 1e-12);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    const flagVal = flags ? Number(flags[i]) : 0;
    const finite = Number.isFinite(v);
    const bad = flags != null && isBadFlag(flagVal);
    const sat = flags != null && isSaturatedFlag(flagVal);

    if (showFlags && (!finite || bad)) {
      const [r, g, b, a] = hatchRgba(i, width);
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = a;
      continue;
    }

    // Archive look: NaN and masked-saturated cores → plain black (no hatch).
    if (!finite || sat) {
      out.data[o] = BLACK[0];
      out.data[o + 1] = BLACK[1];
      out.data[o + 2] = BLACK[2];
      out.data[o + 3] = BLACK[3];
      continue;
    }

    let x = Math.min(Math.max(v, vmin), vmax);
    let y: number;
    if (mode === "linear") y = (x - vmin) / span;
    else if (mode === "log") y = Math.log1p(x - vmin) / Math.log1p(span);
    else {
      // asinh with soft knee — avoids crushing faint pixels when bright sources exist
      y = Math.asinh((x - vmin) / (span / 3)) / Math.asinh(3);
    }
    const [r, g, b] = applyColormap(y, cmap);
    out.data[o] = r;
    out.data[o + 1] = g;
    out.data[o + 2] = b;
    out.data[o + 3] = 255;
  }
  return out as ImageData;
}

/** Defaults for the "Match archive look" preset (display only). */
export const ARCHIVE_LOOK = {
  stretch: "asinh" as StretchMode,
  clipLo: 1,
  clipHi: 99.5,
  cmap: "gray" as Colormap,
  interp: false,
  showFlags: false,
};
