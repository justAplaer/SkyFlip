/**
 * Tiled full-detector SPHEREx IMAGE viewer.
 *
 * Root-cause fix (see CHANGELOG_FIX.md): previous paint() was async, called
 * setState mid-draw, and a frames-identity reset wiped zoom/index on every
 * parent re-render. View is now a single {centerRa,centerDec,scale} source of
 * truth (refs + React state), drawn via rAF when dirty.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  } from "react";
import type { CutoutFrame, FramePyramidMeta, PredictedTrackPoint } from "../types";
import { apiUrl } from "../lib/api";
import {
  chooseLevel,
  fetchFlagsTile,
  fetchImageTile,
  TileLru,
} from "../lib/tileCache";
import {
  clampScale,
  fitScaleFor,
  framesSignature,
  MAX_SCALE,
  MIN_BOX_CSS_PX,
  pushHistory,
  type FullFrameView,
  type ToolMode,
  viewFromImageBox,
  ZOOM_STEP,
} from "../lib/fullFrameView";
import {
  parseTanWcs,
  pixelInFrame,
  pixelToWorld,
  worldToPixel,
  type TanWcs,
} from "../lib/wcsSky";
import { SliderWithInput } from "./SliderWithInput";

const CSS = 640;
const MAX_HZ = 3;
const PIXEL_SCALE_ARCSEC = 6.15;

type StretchKind = "linear" | "asinh" | "sqrt" | "log";

interface Props {
  timePoint?: { ra: number; dec: number; decimal_year: number } | null;
  timeLabel?: string;
  timeTrail?: {ra:number; dec:number}[];
  holdBlink?: boolean;
  timeJump?: {id:string; nonce:number} | null;
  timeCenter?: number;
  frames: CutoutFrame[];
  fieldRa: number;
  fieldDec: number;
  subtractZodi: boolean;
  ghost?: PredictedTrackPoint[];
  showGhost?: boolean;
  initialIndex?: number;
  onEpochChange?: (i: number) => void;
  onMeta?: (
    meta: FramePyramidMeta | null,
    stretch: { lo: number; hi: number; mode: StretchKind },
  ) => void;
  /** Click (no drag) → sky coords for coordinate box / “Use this position”. */
  onSkyClick?: (ra: number, dec: number) => void;
  /** Scientist details: open the Image tools / Display settings menus by default. */
  expanded?: boolean;
}

function levelDims(ny: number, nx: number, level: number): { ny: number; nx: number } {
  const f = 1 << level;
  return { ny: Math.max(1, Math.ceil(ny / f)), nx: Math.max(1, Math.ceil(nx / f)) };
}

function stretchValue(v: number, lo: number, hi: number, mode: StretchKind): number {
  if (!Number.isFinite(v)) return 0;
  const span = hi - lo || 1;
  let t = (v - lo) / span;
  t = Math.min(1, Math.max(0, t));
  if (mode === "sqrt") return Math.sqrt(t);
  if (mode === "log") return Math.log1p(9 * t) / Math.log(10);
  if (mode === "asinh") return Math.asinh(10 * t) / Math.asinh(10);
  return t;
}

export function FullFrameStage({
  frames,
  fieldRa,
  fieldDec,
  subtractZodi,
  ghost = [],
  showGhost = true,
  initialIndex = 0,
  onEpochChange,
  onMeta,
  onSkyClick,
  expanded = false,
  timePoint = null,
  timeLabel = "Predicted",
  timeTrail = [],
  holdBlink = false,
  timeJump = null,
  timeCenter = 0,
}: Props) {
  const timeOverlayRef = useRef({ timePoint, timeTrail, timeLabel });
  timeOverlayRef.current = { timePoint, timeTrail, timeLabel };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef(new TileLru(96));
  const dirtyRef = useRef(true);
  const paintGenRef = useRef(0);
  const viewRef = useRef<FullFrameView>({
    centerRa: fieldRa,
    centerDec: fieldDec,
    scale: 0.3,
  });
  const metaByKeyRef = useRef<Record<string, FramePyramidMeta>>({});
  const indexRef = useRef(initialIndex);
  const framesSigRef = useRef("");

  const [index, setIndex] = useState(initialIndex);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { if (holdBlink) setPlaying(false); }, [holdBlink]);
  useEffect(() => {
    if (!timeJump) return;
    const next = frames.findIndex(frame => frame.epoch_id === timeJump.id);
    if (next >= 0) { setPlaying(false); setIndex(next); }
  }, [timeJump, frames]);
  const [hz, setHz] = useState(1.5);
  const [metaByKey, setMetaByKey] = useState<Record<string, FramePyramidMeta>>({});
  const [loadNote, setLoadNote] = useState("Loading coarsest tiles…");
  const [outside, setOutside] = useState(false);
  const [stretchMode, setStretchMode] = useState<StretchKind>("linear");
  const [sharedLimits, setSharedLimits] = useState<{ lo: number; hi: number } | null>(null);
  const [showFlags, setShowFlags] = useState(false);
  const [smooth, setSmooth] = useState(false);
  const [view, setView] = useState<FullFrameView>({
    centerRa: fieldRa,
    centerDec: fieldDec,
    scale: 0.3,
  });
  const [tool, setTool] = useState<ToolMode>("pan");
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<FullFrameView[]>([]);
  const [boxCss, setBoxCss] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [boxReadout, setBoxReadout] = useState("");
  const dragRef = useRef<{
    kind: "pan" | "box";
    x: number;
    y: number;
    view: FullFrameView;
  } | null>(null);
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  const outsideRef = useRef(false);

  indexRef.current = index;
  metaByKeyRef.current = metaByKey;
  viewRef.current = view;

  const frame = frames[Math.min(index, Math.max(0, frames.length - 1))];
  const metaKey = frame
    ? `${frame.obs_id}|${frame.detector}|z${subtractZodi ? 1 : 0}`
    : "";
  const meta = metaKey ? metaByKey[metaKey] : undefined;

  const fitScale = useMemo(() => {
    if (!meta) return 0.3;
    return fitScaleFor(meta.naxis1, meta.naxis2, CSS);
  }, [meta]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  const commitView = useCallback(
    (next: FullFrameView, pushHist = true) => {
      const clamped = {
        ...next,
        scale: clampScale(next.scale, fitScale),
      };
      if (pushHist) {
        setHistory((h) => pushHistory(h, viewRef.current));
      }
      viewRef.current = clamped;
      setView(clamped);
      markDirty();
    },
    [fitScale, markDirty],
  );

  useEffect(() => {
    if (timeCenter && timePoint) commitView({centerRa: timePoint.ra, centerDec: timePoint.dec, scale: viewRef.current.scale});
    // Trigger only when requested, not on each animation tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeCenter]);

  const goBack = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1]!;
      viewRef.current = prev;
      setView(prev);
      markDirty();
      return h.slice(0, -1);
    });
  }, [markDirty]);

  // Reset only when the epoch set / zodi / field actually changes — not on array identity.
  useEffect(() => {
    const sig = `${framesSignature(frames)}|z${subtractZodi ? 1 : 0}|${fieldRa}|${fieldDec}`;
    if (sig === framesSigRef.current) return;
    framesSigRef.current = sig;
    cacheRef.current.clear();
    setMetaByKey({});
    metaByKeyRef.current = {};
    setSharedLimits(null);
    setIndex(0);
    indexRef.current = 0;
    setPlaying(false);
    setHistory([]);
    // Start centred on the target at 1:1 (one SPHEREx pixel per screen pixel): zoomed out
    // enough that pixels don't look blocky, close enough that the target isn't lost.
    // Zoom / Go to target magnify from here.
    const next = {
      centerRa: fieldRa,
      centerDec: fieldDec,
      scale: 1,
    };
    viewRef.current = next;
    setView(next);
    markDirty();
  }, [frames, fieldRa, fieldDec, subtractZodi, markDirty]);

  useEffect(() => {
    onEpochChange?.(index);
  }, [index, onEpochChange]);

  // Load pyramid meta for current (+ prefetch)
  useEffect(() => {
    let cancelled = false;
    async function loadOne(f: CutoutFrame) {
      const key = `${f.obs_id}|${f.detector}|z${subtractZodi ? 1 : 0}`;
      if (metaByKeyRef.current[key]) return;
      const q = new URLSearchParams({
        subtract_zodi: subtractZodi ? "true" : "false",
        ra: String(fieldRa),
        dec: String(fieldDec),
      });
      if (f.source_url) q.set("access_url", f.source_url);
      if (f.bandpass) q.set("bandpass", f.bandpass);
      if (f.mjd != null) q.set("mjd", String(f.mjd));
      const path =
        f.frame_meta_url?.split("?")[0] ??
        `/api/frame/${encodeURIComponent(f.obs_id)}/${f.detector}/meta`;
      const url = apiUrl(`${path}?${q}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`meta ${r.status}`);
      const m = (await r.json()) as FramePyramidMeta;
      if (cancelled) return;
      setMetaByKey((prev) => {
        const next = { ...prev, [key]: m };
        metaByKeyRef.current = next;
        return next;
      });
      setSharedLimits((prev) => {
        if (prev) return prev;
        return {
          lo: m.stats?.p01 ?? m.stats?.z1 ?? 0,
          hi: m.stats?.p995 ?? m.stats?.z2 ?? 1,
        };
      });
      markDirty();
    }
    if (!frame) return;
    setLoadNote("Fetching frame metadata…");
    loadOne(frame)
      .then(() => setLoadNote(""))
      .catch((e) => setLoadNote(String(e)));
    for (const f of frames) {
      if (f !== frame) void loadOne(f).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [frame, frames, subtractZodi, fieldRa, fieldDec, markDirty]);

  const wcsFor = useCallback(
    (m: FramePyramidMeta): TanWcs | null => {
      const shape = m.shape;
      const ny = Array.isArray(shape) ? Number(shape[0]) : m.naxis2;
      const nx = Array.isArray(shape) ? Number(shape[1]) : m.naxis1;
      return parseTanWcs(m.wcs, { nx, ny });
    },
    [],
  );

  // Once first meta arrives, zoom so the target is clearly visible (keep sky center).
  useEffect(() => {
    if (!meta) return;
    const fit = fitScaleFor(meta.naxis1, meta.naxis2, CSS);
    const want = clampScale(Math.max(2.4, fit * 8), fit);
    // Only auto-zoom after a fresh field reset (scale was seeded at 2.4).
    if (Math.abs(viewRef.current.scale - 2.4) < 1e-6) {
      let centerRa = fieldRa;
      let centerDec = fieldDec;
      const wcs = wcsFor(meta);
      if (
        wcs &&
        frame?.target_x_pix != null &&
        frame?.target_y_pix != null
      ) {
        const sky = pixelToWorld(wcs, frame.target_x_pix, frame.target_y_pix);
        centerRa = sky.ra;
        centerDec = sky.dec;
      }
      const next = { centerRa, centerDec, scale: want };
      viewRef.current = next;
      setView(next);
      markDirty();
    }
  }, [meta, markDirty, fieldRa, fieldDec, frame, wcsFor]);

  const metasReady =
    frames.length > 0 &&
    frames.every((f) => {
      const k = `${f.obs_id}|${f.detector}|z${subtractZodi ? 1 : 0}`;
      return Boolean(metaByKey[k]);
    });

  // Auto-start blink once every epoch has meta (tiles still stream in).
  useEffect(() => {
    if (!metasReady || frames.length < 2) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    setPlaying(true);
  }, [metasReady, frames.length]);

  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;
  useEffect(() => {
    if (meta && sharedLimits) {
      onMetaRef.current?.(meta, {
        lo: sharedLimits.lo,
        hi: sharedLimits.hi,
        mode: stretchMode,
      });
    }
  }, [meta, sharedLimits, stretchMode]);

  // Playback — restart timer whenever hz changes; never reset epoch.
  useEffect(() => {
    if (!playing || frames.length < 2 || !metasReady) return;
    const rate = Math.min(MAX_HZ, Math.max(0.2, hz));
    const ms = 1000 / rate;
    const id = window.setInterval(() => {
      setIndex((i) => {
        // Skip ahead only to epochs that have meta; avoid frozen previous image.
        let n = i;
        for (let step = 0; step < frames.length; step++) {
          n = (n + 1) % frames.length;
          const f = frames[n]!;
          const k = `${f.obs_id}|${f.detector}|z${subtractZodi ? 1 : 0}`;
          if (metaByKeyRef.current[k]) break;
        }
        indexRef.current = n;
        return n;
      });
      markDirty();
    }, ms);
    return () => window.clearInterval(id);
  }, [playing, hz, frames, frames.length, markDirty, metasReady, subtractZodi]);

  // rAF draw loop — never setState inside the draw path
  useEffect(() => {
    let raf = 0;
    let alive = true;
    let drawing = false;

    const tick = () => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      if (!dirtyRef.current || drawing) return;
      dirtyRef.current = false;
      drawing = true;
      void drawOnce().finally(() => { drawing = false; });
    };

    async function drawOnce() {
      const canvas = canvasRef.current;
      const gen = ++paintGenRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== CSS * dpr || canvas.height !== CSS * dpr) {
        canvas.width = CSS * dpr;
        canvas.height = CSS * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const idx = indexRef.current;
      const fr = frames[Math.min(idx, Math.max(0, frames.length - 1))];
      if (!fr) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, CSS, CSS);
        return;
      }
      const key = `${fr.obs_id}|${fr.detector}|z${subtractZodi ? 1 : 0}`;
      const m = metaByKeyRef.current[key];
      const limits = sharedLimits;
      if (!m || !limits) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, CSS, CSS);
        ctx.fillStyle = "#c9a227";
        ctx.font = "13px monospace";
        ctx.fillText("Loading frame…", 24, CSS / 2);
        return;
      }
      const wcs = wcsFor(m);
      if (!wcs) return;
      const v = viewRef.current;
      const centerPix = worldToPixel(wcs, v.centerRa, v.centerDec);

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, CSS, CSS);
      ctx.imageSmoothingEnabled = smooth || v.scale < 1;

      if (!pixelInFrame(wcs, centerPix.x, centerPix.y, 50)) {
        ctx.fillStyle = "#c9a227";
        ctx.font = "14px monospace";
        ctx.fillText("Outside this detector for this epoch", 24, CSS / 2);
        if (!outsideRef.current) {
          outsideRef.current = true;
          queueMicrotask(() => setOutside(true));
        }
        return;
      }
      if (outsideRef.current) {
        outsideRef.current = false;
        queueMicrotask(() => setOutside(false));
      }

      const tile = m.tile_size || 256;
      const level = chooseLevel(m.n_levels, v.scale);
      const factor = 1 << level;
      const { ny: ly, nx: lx } = levelDims(m.naxis2, m.naxis1, level);
      const halfW = CSS / (2 * v.scale);
      const halfH = CSS / (2 * v.scale);
      const x0 = centerPix.x - halfW;
      const y0 = centerPix.y - halfH;
      const x1 = centerPix.x + halfW;
      const y1 = centerPix.y + halfH;
      const lx0 = Math.floor(x0 / factor);
      const ly0 = Math.floor(y0 / factor);
      const lx1 = Math.ceil(x1 / factor);
      const ly1 = Math.ceil(y1 / factor);
      const tx0 = Math.max(0, Math.floor(lx0 / tile));
      const ty0 = Math.max(0, Math.floor(ly0 / tile));
      const tx1 = Math.min(Math.ceil(lx / tile) - 1, Math.floor((lx1 - 1) / tile));
      const ty1 = Math.min(Math.ceil(ly / tile) - 1, Math.floor((ly1 - 1) / tile));

      const tasks: Promise<void>[] = [];
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const tileNx = Math.min(tile, lx - tx * tile);
          const tileNy = Math.min(tile, ly - ty * tile);
          tasks.push(
            (async () => {
              try {
                const img = await fetchImageTile(cacheRef.current, {
                  obsId: fr.obs_id,
                  detector: fr.detector,
                  level,
                  ty,
                  tx,
                  subtractZodi,
                  expectNy: tileNy,
                  expectNx: tileNx,
                });
                if (gen !== paintGenRef.current) return;
                let flags: Int32Array | null = null;
                if (showFlags) {
                  const fl = await fetchFlagsTile(cacheRef.current, {
                    obsId: fr.obs_id,
                    detector: fr.detector,
                    level,
                    ty,
                    tx,
                    subtractZodi,
                    expectNy: tileNy,
                    expectNx: tileNx,
                  });
                  flags = fl.data as Int32Array;
                }
                if (gen !== paintGenRef.current) return;
                const ny = img.ny;
                const nx = img.nx;
                const rgba = new Uint8ClampedArray(ny * nx * 4);
                const data = img.data as Float32Array;
                for (let i = 0; i < ny * nx; i++) {
                  const t = stretchValue(data[i]!, limits.lo, limits.hi, stretchMode);
                  const g = Math.round(t * 255);
                  const o = i * 4;
                  rgba[o] = g;
                  rgba[o + 1] = g;
                  rgba[o + 2] = g;
                  rgba[o + 3] = 255;
                  if (flags && flags[i] && (i + Math.floor(i / nx)) % 4 === 0) {
                    rgba[o] = 160;
                    rgba[o + 1] = 80;
                    rgba[o + 2] = 200;
                  }
                }
                const off = document.createElement("canvas");
                off.width = nx;
                off.height = ny;
                off.getContext("2d")?.putImageData(new ImageData(rgba, nx, ny), 0, 0);
                if (gen !== paintGenRef.current) return;
                const nativeX = tx * tile * factor;
                const nativeY = ty * tile * factor;
                const dx = (nativeX - centerPix.x) * v.scale + CSS / 2;
                const dy = (nativeY - centerPix.y) * v.scale + CSS / 2;
                ctx.drawImage(off, dx, dy, nx * factor * v.scale, ny * factor * v.scale);
              } catch {
                /* tile miss */
              }
            })(),
          );
        }
      }
      await Promise.all(tasks);
      if (gen !== paintGenRef.current) return;

      // HUD overlays (drawn into main canvas — no pointer capture)
      ctx.strokeStyle = "rgba(201,162,39,0.7)";
      ctx.beginPath();
      ctx.moveTo(0, CSS - 28);
      ctx.lineTo(CSS, CSS - 28);
      ctx.moveTo(28, 0);
      ctx.lineTo(28, CSS);
      ctx.stroke();
      ctx.fillStyle = "#c9a227";
      ctx.font = "11px monospace";
      ctx.fillText(`${Math.round(centerPix.x)}`, CSS / 2 - 10, CSS - 10);
      ctx.fillText(`${Math.round(centerPix.y)}`, 4, CSS / 2);

      const { timePoint: currentTimePoint, timeTrail: currentTimeTrail, timeLabel: currentTimeLabel } = timeOverlayRef.current;
      if (currentTimePoint) {
        ctx.strokeStyle = "rgba(238,188,96,.75)"; ctx.lineWidth = 1.5; ctx.beginPath(); let started = false;
        for (const sky of currentTimeTrail) { const pixel = worldToPixel(wcs,sky.ra,sky.dec); const x = (pixel.x-centerPix.x)*v.scale+CSS/2, y = (pixel.y-centerPix.y)*v.scale+CSS/2; if (!Number.isFinite(x) || !Number.isFinite(y)) continue; if (!started) {ctx.moveTo(x,y);started=true;} else ctx.lineTo(x,y); } ctx.stroke();
        const pt = worldToPixel(wcs, currentTimePoint.ra, currentTimePoint.dec);
        const x = (pt.x - centerPix.x) * v.scale + CSS / 2, y = (pt.y - centerPix.y) * v.scale + CSS / 2;
        if (Number.isFinite(x) && Number.isFinite(y)) { ctx.strokeStyle = "#eebc60"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x,y,10,0,2*Math.PI); ctx.stroke(); ctx.fillStyle = "#eebc60"; ctx.font = "11px monospace"; ctx.fillText(`${currentTimeLabel} ${currentTimePoint.decimal_year.toFixed(1)}`,x+12,y); }
      }

      // Cyan target circle — always when we know the pixel (not tied to ghost-track toggle)
      {
        let gx: number | null = null;
        let gy: number | null = null;
        if (fr.target_x_pix != null && fr.target_y_pix != null) {
          gx = (fr.target_x_pix - centerPix.x) * v.scale + CSS / 2;
          gy = (fr.target_y_pix - centerPix.y) * v.scale + CSS / 2;
        } else if (showGhost) {
          const g = ghost.find((p) => p.epoch_id === fr.epoch_id) ?? ghost[idx];
          if (g?.ra != null && g.dec != null) {
            const gp = worldToPixel(wcs, g.ra, g.dec);
            gx = (gp.x - centerPix.x) * v.scale + CSS / 2;
            gy = (gp.y - centerPix.y) * v.scale + CSS / 2;
          }
        }
        if (gx != null && gy != null) {
          ctx.strokeStyle = "#7dd3fc";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(gx, gy, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = "#7dd3fc";
          ctx.font = "12px IBM Plex Mono, monospace";
          ctx.fillText("target", gx + 12, gy);
        }
      }

      const barNative = 30;
      const barPx = barNative * v.scale;
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(CSS - 24 - barPx, 24);
      ctx.lineTo(CSS - 24, 24);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.fillText(`${(barNative * PIXEL_SCALE_ARCSEC).toFixed(0)}″`, CSS - 24 - barPx, 18);
    }

    raf = requestAnimationFrame(tick);
    markDirty();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [
    frames,
    subtractZodi,
    sharedLimits,
    stretchMode,
    showFlags,
    smooth,
    showGhost,
    ghost,
    wcsFor,
    markDirty,
  ]);

  // Redraw when view / index / meta changes
  useEffect(() => {
    markDirty();
  }, [view, index, meta, timePoint, markDirty]);

  // Draw box overlay (pointer-events: none)
  useEffect(() => {
    const ov = overlayRef.current;
    if (!ov) return;
    const dpr = window.devicePixelRatio || 1;
    ov.width = CSS * dpr;
    ov.height = CSS * dpr;
    const ctx = ov.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CSS, CSS);
    if (!boxCss) return;
    const x = Math.min(boxCss.x0, boxCss.x1);
    const y = Math.min(boxCss.y0, boxCss.y1);
    const w = Math.abs(boxCss.x1 - boxCss.x0);
    const h = Math.abs(boxCss.y1 - boxCss.y0);
    ctx.fillStyle = "rgba(201,162,39,0.15)";
    ctx.strokeStyle = "rgba(201,162,39,0.95)";
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }, [boxCss]);

  const cssToImage = useCallback(
    (mx: number, my: number, wcs: TanWcs, v: FullFrameView) => {
      const centerPix = worldToPixel(wcs, v.centerRa, v.centerDec);
      return {
        x: centerPix.x + (mx - CSS / 2) / v.scale,
        y: centerPix.y + (my - CSS / 2) / v.scale,
      };
    },
    [],
  );

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!meta) return;
    const wcs = wcsFor(meta);
    if (!wcs) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = ((e.clientX - rect.left) / rect.width) * CSS;
    const my = ((e.clientY - rect.top) / rect.height) * CSS;
    const v = viewRef.current;
    const img = cssToImage(mx, my, wcs, v);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextScale = clampScale(v.scale * factor, fitScale);
    const newCenterPix = {
      x: img.x - (mx - CSS / 2) / nextScale,
      y: img.y - (my - CSS / 2) / nextScale,
    };
    const c = pixelToWorld(wcs, newCenterPix.x, newCenterPix.y);
    commitView({ centerRa: c.ra, centerDec: c.dec, scale: nextScale }, false);
  };

  const wheelHandler = useRef(onWheel);
  wheelHandler.current = onWheel;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = (event: WheelEvent) => wheelHandler.current(event);
    canvas.addEventListener("wheel", handle, { passive: false });
    return () => canvas.removeEventListener("wheel", handle);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button === 0 && tool === "pan") setDragging(true);
    if (e.button === 2) {
      e.preventDefault();
      goBack();
      return;
    }
    if (e.pointerType === "touch" && e.isPrimary === false) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = ((e.clientX - rect.left) / rect.width) * CSS;
    const my = ((e.clientY - rect.top) / rect.height) * CSS;
    if (tool === "box") {
      dragRef.current = { kind: "box", x: mx, y: my, view: viewRef.current };
      setBoxCss({ x0: mx, y0: my, x1: mx, y1: my });
      setBoxReadout("");
    } else {
      dragRef.current = {
        kind: "pan",
        x: e.clientX,
        y: e.clientY,
        view: viewRef.current,
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    // Pinch (two touches approximated via ctrl+wheel elsewhere; simple distance if available)
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "box") {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !meta) return;
      const wcs = wcsFor(meta);
      if (!wcs) return;
      const mx = ((e.clientX - rect.left) / rect.width) * CSS;
      const my = ((e.clientY - rect.top) / rect.height) * CSS;
      setBoxCss({ x0: d.x, y0: d.y, x1: mx, y1: my });
      const a = cssToImage(d.x, d.y, wcs, d.view);
      const b = cssToImage(mx, my, wcs, d.view);
      const wPix = Math.abs(b.x - a.x);
      const hPix = Math.abs(b.y - a.y);
      setBoxReadout(
        `${wPix.toFixed(0)}×${hPix.toFixed(0)} px · ${(wPix * PIXEL_SCALE_ARCSEC).toFixed(0)}″×${(hPix * PIXEL_SCALE_ARCSEC).toFixed(0)}″`,
      );
      return;
    }
    if (!meta) return;
    const wcs = wcsFor(meta);
    if (!wcs) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const centerPix = worldToPixel(wcs, d.view.centerRa, d.view.centerDec);
    const next = pixelToWorld(
      wcs,
      centerPix.x - dx / d.view.scale,
      centerPix.y - dy / d.view.scale,
    );
    commitView(
      { centerRa: next.ra, centerDec: next.dec, scale: d.view.scale },
      false,
    );
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    setDragging(false);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.kind !== "box" || !meta) {
      setBoxCss(null);
      setBoxReadout("");
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = ((e.clientX - rect.left) / rect.width) * CSS;
    const my = ((e.clientY - rect.top) / rect.height) * CSS;
    const w = Math.abs(mx - d.x);
    const h = Math.abs(my - d.y);
    setBoxCss(null);
    setBoxReadout("");
    const wcs = wcsFor(meta);
    if (!wcs) return;
    if (w < MIN_BOX_CSS_PX || h < MIN_BOX_CSS_PX) {
      const img = cssToImage(mx, my, wcs, d.view);
      const sky = pixelToWorld(wcs, img.x, img.y);
      onSkyClick?.(sky.ra, sky.dec);
      return;
    }
    const a = cssToImage(d.x, d.y, wcs, d.view);
    const b = cssToImage(mx, my, wcs, d.view);
    const next = viewFromImageBox(
      a.x,
      a.y,
      b.x,
      b.y,
      d.view.centerRa,
      d.view.centerDec,
      fitScale,
      CSS,
      (x, y) => pixelToWorld(wcs, x, y),
    );
    commitView(next, true);
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!meta) return;
    const wcs = wcsFor(meta);
    if (!wcs) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = ((e.clientX - rect.left) / rect.width) * CSS;
    const my = ((e.clientY - rect.top) / rect.height) * CSS;
    const v = viewRef.current;
    const img = cssToImage(mx, my, wcs, v);
    const sky = pixelToWorld(wcs, img.x, img.y);
    commitView(
      { centerRa: sky.ra, centerDec: sky.dec, scale: clampScale(v.scale * 2, fitScale) },
      true,
    );
  };

  // Touch pinch
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length !== 2) {
        pinchRef.current = null;
        return;
      }
      ev.preventDefault();
      const a = ev.touches[0]!;
      const b = ev.touches[1]!;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!pinchRef.current) {
        pinchRef.current = { dist, scale: viewRef.current.scale };
        return;
      }
      const factor = dist / Math.max(pinchRef.current.dist, 1);
      commitView(
        {
          ...viewRef.current,
          scale: clampScale(pinchRef.current.scale * factor, fitScale),
        },
        false,
      );
    };
    const onTouchEnd = () => {
      pinchRef.current = null;
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [commitView, fitScale]);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") {
        setIndex((i) => Math.min(frames.length - 1, i + 1));
        markDirty();
      } else if (e.key === "ArrowLeft") {
        setIndex((i) => Math.max(0, i - 1));
        markDirty();
      } else if (e.key === "Escape") {
        dragRef.current = null;
        setBoxCss(null);
        setBoxReadout("");
      } else if (e.key === "p" || e.key === "P") {
        setTool("pan");
      } else if (e.key === "b" || e.key === "B") {
        setTool("box");
      } else if (e.key === "s" || e.key === "S") {
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames.length, markDirty]);

  const goToTarget = () => {
    if (!frame || !meta) return;
    const wcs = wcsFor(meta);
    if (!wcs) return;
    if (frame.target_x_pix != null && frame.target_y_pix != null) {
      const sky = pixelToWorld(wcs, frame.target_x_pix, frame.target_y_pix);
      commitView(
        { centerRa: sky.ra, centerDec: sky.dec, scale: clampScale(Math.max(2, fitScale * 8), fitScale) },
        true,
      );
    } else {
      commitView(
        {
          centerRa: fieldRa,
          centerDec: fieldDec,
          scale: clampScale(Math.max(2, fitScale * 8), fitScale),
        },
        true,
      );
    }
  };

  const cursor =
    tool === "box" ? "crosshair" : tool === "pan" ? (dragging ? "grabbing" : "grab") : "default";

  return (
    <section className="full-frame-stage" aria-label="SPHEREx full-frame blink player">
      <div className="blink-toolbar ff-primary" role="toolbar" aria-label="Full-frame controls">
        <button
          type="button"
          data-testid="ff-play"
          className="btn-blink"
          aria-pressed={playing}
          aria-label={playing ? "Pause" : metasReady ? "Play" : "Loading…"}
          disabled={!metasReady || frames.length < 2}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? "❚❚ Pause" : metasReady ? "▶ Blink" : "Loading…"}
        </button>
        <button
          type="button"
          data-testid="ff-step-prev"
          onClick={() => {
            setIndex((i) => Math.max(0, i - 1));
            markDirty();
          }}
        >
          Step −
        </button>
        <button
          type="button"
          data-testid="ff-step-next"
          onClick={() => {
            setIndex((i) => Math.min(frames.length - 1, i + 1));
            markDirty();
          }}
        >
          Step +
        </button>
        {frames.length > 1 && (
          <input
            type="range"
            className="visit-slider"
            aria-label="Visit"
            min={0}
            max={frames.length - 1}
            value={index}
            onChange={(e) => {
              setPlaying(false);
              setIndex(Number(e.target.value));
              markDirty();
            }}
          />
        )}
      </div>
      <details className="tools-menu" open={expanded || undefined}>
        <summary>⋯ Image tools</summary>
      <div className="blink-toolbar" role="toolbar" aria-label="Zoom controls">
        <button
          type="button"
          data-testid="ff-zoom-in"
          onClick={() =>
            commitView(
              { ...viewRef.current, scale: clampScale(viewRef.current.scale * ZOOM_STEP, fitScale) },
              true,
            )
          }
        >
          Zoom in
        </button>
        <button
          type="button"
          data-testid="ff-zoom-out"
          onClick={() =>
            commitView(
              {
                ...viewRef.current,
                scale: clampScale(viewRef.current.scale / ZOOM_STEP, fitScale),
              },
              true,
            )
          }
        >
          Zoom out
        </button>
        <button
          type="button"
          data-testid="ff-fit"
          onClick={() => commitView({ ...viewRef.current, scale: fitScale }, true)}
        >
          Fit frame
        </button>
        <button type="button" data-testid="ff-goto-target" onClick={goToTarget}>
          Go to target
        </button>
        <button
          type="button"
          data-testid="ff-one-to-one"
          onClick={() => commitView({ ...viewRef.current, scale: 1 }, true)}
        >
          1:1
        </button>
        <button
          type="button"
          data-testid="ff-back"
          disabled={!history.length}
          onClick={goBack}
        >
          Back
        </button>
      </div>

      <div className="tool-switcher" role="group" aria-label="Pointer tool">
        {(
          [
            ["pan", "Pan", "P"],
            ["box", "Box zoom", "B"],
            ["select", "Select", "S"],
          ] as const
        ).map(([id, label, key]) => (
          <button
            key={id}
            type="button"
            data-testid={`ff-tool-${id}`}
            className={tool === id ? "active" : ""}
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
          >
            {label} <kbd>{key}</kbd>
          </button>
        ))}
      </div>
      </details>

      <div className="blink-canvas-wrap">
        <canvas
          ref={canvasRef}
          data-testid="ff-canvas"
          width={CSS}
          height={CSS}
          style={{ width: CSS, height: CSS, cursor, background: "#000", userSelect: "none", touchAction: "none" }}
          onDoubleClick={onDoubleClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        <canvas
          ref={overlayRef}
          className="ff-overlay"
          width={CSS}
          height={CSS}
          style={{ width: CSS, height: CSS }}
          aria-hidden
        />
        {loadNote ? (
          <div className="tile-progress" role="status" style={{ pointerEvents: "none" }}>
            {loadNote}
          </div>
        ) : null}
        {outside ? (
          <div className="tile-progress" role="status" style={{ pointerEvents: "none" }}>
            outside this detector
          </div>
        ) : null}
        {boxReadout ? (
          <div className="box-readout" role="status" style={{ pointerEvents: "none" }}>
            {boxReadout}
          </div>
        ) : null}
      </div>

      <div className="blink-controls">
        <SliderWithInput
          label="Blink speed"
          min={0.2}
          max={MAX_HZ}
          step={0.1}
          value={hz}
          onChange={setHz}
          unit="Hz"
          decimals={1}
          clampNote="Capped at 3 Hz"
        />
        <SliderWithInput
          label="Zoom"
          min={Number((fitScale * 0.5).toFixed(3))}
          max={MAX_SCALE}
          step={0.05}
          value={Number(view.scale.toFixed(3))}
          onChange={(s) => commitView({ ...viewRef.current, scale: s }, true)}
          unit="×"
          decimals={2}
          allowBeyondMax
          hardMax={32}
        />
      </div>
      <details className="tools-menu" open={expanded || undefined}>
        <summary>Display settings</summary>
      <div className="blink-controls">
        <label>
          Stretch{" "}
          <select
            value={stretchMode}
            onChange={(e) => {
              setStretchMode(e.target.value as StretchKind);
              markDirty();
            }}
          >
            <option value="linear">linear</option>
            <option value="asinh">asinh</option>
            <option value="sqrt">sqrt</option>
            <option value="log">log</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showFlags}
            onChange={(e) => {
              setShowFlags(e.target.checked);
              markDirty();
            }}
          />{" "}
          Show flagged pixels
        </label>
        <label>
          <input
            type="checkbox"
            checked={smooth}
            onChange={(e) => {
              setSmooth(e.target.checked);
              markDirty();
            }}
          />{" "}
          Bilinear when zoomed in
        </label>
      </div>
      </details>
      <p
        className="muted"
        data-testid="ff-status"
        data-obs-id={frame?.obs_id ?? ""}
        data-epoch-index={index}
        data-epoch-count={frames.length}
      >
        Epoch {index + 1} of {frames.length}
        {frame?.time_iso ? ` · ${frame.time_iso.slice(0, 10)}` : ""}
        {expanded && frame?.obs_id ? ` · ${frame.obs_id}` : ""}
        {expanded && frame ? ` · D${frame.detector}` : ""}
        {expanded && frame?.central_wavelength_um != null
          ? ` · λ ${Number(frame.central_wavelength_um).toFixed(3)} µm`
          : ""}
        {expanded && meta
          ? ` · ${meta.naxis1}×${meta.naxis2} · L${chooseLevel(meta.n_levels, view.scale)}`
          : ""}
        {expanded ? ` · zoom ${view.scale.toFixed(2)}×` : ""}
        {!metasReady ? " · preloading epochs…" : ""}
      </p>
    </section>
  );
}
