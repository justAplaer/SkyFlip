import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CutoutFrame, PredictedTrackPoint, TrailPoint } from "../types";
import { apiUrl } from "../lib/api";
import { framesSignature } from "../lib/fullFrameView";
import { SliderWithInput } from "./SliderWithInput";
import { trailColor } from "../lib/changeScoreMath";
import {
  ARCHIVE_LOOK,
  flaggedPixelLegend,
  percentileClip,
  stretchToRgba,
  type Colormap,
  type StretchMode,
} from "../lib/stretch";
import { frameWcs, pixelInside } from "../lib/frameWcs";
import { pixelToWorld, worldToPixel } from "../lib/wcsSky";
import {
  CSS_CANVAS,
  PIXEL_SCALE_ARCSEC,
  ZoomStack,
  canvasToImage,
  clampRect,
  expandToAspect,
  fovArcsec,
  fullImageRect,
  imageToCanvas,
  lerpRect,
  meetsMinSize,
  normalizeRect,
  panView,
  selectionReadout,
  zoomAtPoint,
  type ViewRect,
} from "../lib/zoomMath";

const MAX_HZ = 3;
/** Number input may zoom beyond the slider's 16× end, up to this. */
const ZOOM_HARD_MAX = 64;
const DEFAULT_HZ = 1.5;
const ZOOM_MS = 250;

interface Props {
  timePoint?: { ra: number; dec: number; decimal_year: number } | null;
  timeLabel?: string;
  timeTrail?: {ra:number; dec:number}[];
  holdBlink?: boolean;
  timeJump?: {id:string; nonce:number} | null;
  timeCenter?: number;
  frames: CutoutFrame[];
  ghost?: PredictedTrackPoint[];
  /** Catalog-epoch markers (Gaia / WISE) in native cutout pixels. */
  historicalMarkers?: import("../types").HistoricalMarker[];
  showGhost?: boolean;
  stretch?: StretchMode;
  initialClipLo?: number;
  initialClipHi?: number;
  initialInterp?: boolean;
  initialColormap?: Colormap;
  /** When true, purple-hatch bad FLAGS / NaN. Default off (archive look). */
  initialShowFlags?: boolean;
  /** How background was handled upstream (shown in HUD). */
  backgroundNote?: string;
  initialIndex?: number;
  onEpochChange?: (index: number) => void;
  onEpochCommit?: (index: number) => void;
  onStretchCommit?: (mode: StretchMode) => void;
  onDisplayCommit?: (opts: {
    stretch: StretchMode;
    clipLo: number;
    clipHi: number;
    interp: boolean;
    cmap: Colormap;
    showFlags: boolean;
  }) => void;
  reducedMotion?: boolean;
  /** Field center RA/Dec — used with per-frame WCS for readout / custom marker. */
  fieldRa?: number;
  fieldDec?: number;
  pixelScaleArcsec?: number;
  /** Draw a sky marker at fieldRa/Dec (custom positions). */
  markFieldCenter?: boolean;
  /** Initial zoom rectangle in native pixels (from URL). */
  initialView?: ViewRect | null;
  onViewCommit?: (view: ViewRect | null, bounds?: { width: number; height: number }) => void;
  /** Offline: disables re-fetch. */
  offline?: boolean;
  onRefetchRegion?: (view: ViewRect) => void;
  /** Centroid trail for kept change-slider frames (image pixels). */
  trail?: TrailPoint[];
  /** Optional predicted track dots for comparison. */
  predictedTrail?: TrailPoint[];
  aperture?: { x: number; y: number; r: number } | null;
  pickAperture?: boolean;
  onAperturePick?: (xPix: number, yPix: number) => void;
  /** Click (no drag): scientific pixel inspect. Shift+click works even in pick-aperture. */
  onInspectPixel?: (xPix: number, yPix: number) => void;
  /** Click fills coordinate box via parent ("Use this position"). */
  onSkyClick?: (ra: number, dec: number) => void;
  /** Scientist details: open the Image tools / Display settings menus by default. */
  expanded?: boolean;
}

function ghostForFrame(
  ghost: PredictedTrackPoint[],
  frame: CutoutFrame | undefined,
  index: number,
): PredictedTrackPoint | undefined {
  if (!frame) return undefined;
  const byId = ghost.find((g) => g.epoch_id === frame.epoch_id);
  if (byId) return byId;
  return ghost[index];
}

type ToolMode = "select" | "pan";

export function BlinkPlayer({
  expanded = false,
  timePoint = null,
  timeLabel = "Predicted",
  timeTrail = [],
  holdBlink = false,
  timeJump = null,
  timeCenter = 0,
  frames,
  ghost = [],
  historicalMarkers = [],
  showGhost = true,
  stretch: stretchProp = "asinh",
  initialClipLo = 1,
  initialClipHi = 99.5,
  initialInterp = false,
  initialColormap = "gray",
  initialShowFlags = false,
  backgroundNote,
  initialIndex = 0,
  onEpochChange,
  onEpochCommit,
  onStretchCommit,
  onDisplayCommit,
  reducedMotion = false,
  fieldRa,
  fieldDec,
  markFieldCenter = false,
  onSkyClick,
  pixelScaleArcsec = PIXEL_SCALE_ARCSEC,
  initialView = null,
  onViewCommit,
  offline = false,
  onRefetchRegion,
  trail = [],
  predictedTrail = [],
  aperture = null,
  pickAperture = false,
  onAperturePick,
  onInspectPixel,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const [index, setIndex] = useState(() =>
    frames.length ? Math.min(Math.max(0, initialIndex), frames.length - 1) : 0,
  );
  const [playing, setPlaying] = useState(!reducedMotion);
  useEffect(() => { if (holdBlink) setPlaying(false); }, [holdBlink]);
  useEffect(() => {
    if (!timeJump) return;
    const next = frames.findIndex(frame => frame.epoch_id === timeJump.id);
    if (next >= 0) { setPlaying(false); setIndex(next); }
  }, [timeJump, frames]);
  const [hz, setHz] = useState(DEFAULT_HZ);
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  const [floatFrames, setFloatFrames] = useState<
    { data: Float32Array; flags: Int16Array | null; w: number; h: number }[]
  >([]);
  const [sharedScale, setSharedScale] = useState<[number, number] | null>(null);
  const [stretchMode, setStretchMode] = useState<StretchMode>(stretchProp);
  const [pctLo, setPctLo] = useState(initialClipLo);
  const [pctHi, setPctHi] = useState(initialClipHi);
  const [interp, setInterp] = useState(initialInterp);
  const [colormap, setColormap] = useState<Colormap>(initialColormap);
  const [showFlags, setShowFlags] = useState(initialShowFlags);
  const [tool, setTool] = useState<ToolMode>("select");
  const [spacePan, setSpacePan] = useState(false);
  const [splitPanel, setSplitPanel] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [cursorReadout, setCursorReadout] = useState("");
  const [dragBox, setDragBox] = useState<ViewRect | null>(null);
  const [kbBox, setKbBox] = useState<ViewRect | null>(null);

  const nativeSize = useMemo(() => {
    const ff = floatFrames.find((f) => f.w > 0);
    if (ff) return { width: ff.w, height: ff.h };
    const img = images.find((i) => i.naturalWidth > 0);
    if (img) return { width: img.naturalWidth, height: img.naturalHeight };
    return { width: 29, height: 29 };
  }, [floatFrames, images]);

  const stackRef = useRef(new ZoomStack());
  const [view, setView] = useState<ViewRect>(() => fullImageRect({ width: 29, height: 29 }));
  const displayViewRef = useRef<ViewRect>(view);
  const [displayView, setDisplayView] = useState<ViewRect>(view);
  const animRef = useRef<number | null>(null);

  const aspect = CSS_CANVAS / CSS_CANVAS; // square canvas

  // Init / reset stack when native size known or initialView changes
  useEffect(() => {
    const full = fullImageRect(nativeSize);
    const stack = new ZoomStack(full);
    if (
      initialView &&
      meetsMinSize(initialView) &&
      initialView.x1 <= nativeSize.width + 1e-6 &&
      initialView.y1 <= nativeSize.height + 1e-6
    ) {
      stack.push(clampRect(initialView, nativeSize));
    }
    stackRef.current = stack;
    const cur = stack.current()!;
    setView(cur);
    setDisplayView(cur);
    displayViewRef.current = cur;
  }, [nativeSize.width, nativeSize.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const animateTo = useCallback(
    (target: ViewRect) => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      const from = displayViewRef.current;
      if (reducedMotion) {
        displayViewRef.current = target;
        setDisplayView(target);
        setView(target);
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ZOOM_MS);
        const eased = 1 - (1 - t) * (1 - t);
        const mid = lerpRect(from, target, eased);
        displayViewRef.current = mid;
        setDisplayView(mid);
        if (t < 1) animRef.current = requestAnimationFrame(step);
        else {
          displayViewRef.current = target;
          setDisplayView(target);
          setView(target);
        }
      };
      animRef.current = requestAnimationFrame(step);
    },
    [reducedMotion],
  );

  const commitView = useCallback(
    (next: ViewRect, push: boolean) => {
      const clamped = clampRect(expandToAspect(next, aspect, nativeSize), nativeSize);
      if (push) stackRef.current.push(clamped);
      else stackRef.current.replaceTop(clamped);
      setView(clamped);
      animateTo(clamped);
      const fov = fovArcsec(clamped);
      setAnnounce(
        `Field of view ${fov.w.toFixed(1)} by ${fov.h.toFixed(1)} arcseconds. No uncertainty available on display FOV.`,
      );
    },
    [animateTo, aspect, nativeSize],
  );

  // Notify parent of view changes only after commit (never during BlinkPlayer render).
  const viewCommitRef = useRef(onViewCommit);
  viewCommitRef.current = onViewCommit;
  const skipFirstViewSync = useRef(true);
  useEffect(() => {
    if (skipFirstViewSync.current) {
      skipFirstViewSync.current = false;
      return;
    }
    const isFull = rectIsFull(view, nativeSize);
    viewCommitRef.current?.(isFull ? null : normalizeRect(view), nativeSize);
  }, [view, nativeSize]);

  const zoomBack = useCallback(() => {
    const prev = stackRef.current.back();
    if (!prev) return;
    setView(prev);
    animateTo(prev);
    const fov = fovArcsec(prev);
    setAnnounce(`Back. FOV ${fov.w.toFixed(1)}×${fov.h.toFixed(1)}″.`);
  }, [animateTo]);

  const zoomReset = useCallback(() => {
    const full = fullImageRect(nativeSize);
    stackRef.current.reset(full);
    setView(full);
    animateTo(full);
    setKbBox(null);
    setAnnounce("Zoom reset to full field.");
  }, [animateTo, nativeSize]);

  const [assetsReady, setAssetsReady] = useState(false);
  const framesSig = useMemo(() => framesSignature(frames), [frames]);
  const framesSigRef = useRef("");
  const floatCacheRef = useRef<
    { data: Float32Array; flags: Int16Array | null; w: number; h: number }[]
  >([]);

  // Reset index only when the epoch set actually changes (not array identity).
  useEffect(() => {
    if (framesSig === framesSigRef.current) return;
    framesSigRef.current = framesSig;
    const next = frames.length
      ? Math.min(Math.max(0, initialIndex), frames.length - 1)
      : 0;
    setIndex(next);
    setPlaying(false);
    setAssetsReady(false);
  }, [framesSig, frames.length, initialIndex]);

  useEffect(() => {
    let cancelled = false;
    const sigAtStart = framesSig;
    (async () => {
      setAssetsReady(false);
      const emptyFloat = {
        data: new Float32Array(0),
        flags: null as Int16Array | null,
        w: 0,
        h: 0,
      };
      // 1) Decode all PNGs in parallel — enough to enable Play.
      const imgs = await Promise.all(
        frames.map(async (f) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = apiUrl(f.image_url);
          await img.decode().catch(() => undefined);
          return img;
        }),
      );
      if (cancelled || sigAtStart !== framesSigRef.current) return;
      setImages(imgs);
      setAssetsReady(imgs.length === frames.length && frames.length > 0);
      if (!reducedMotion && frames.length > 1) setPlaying(true);

      // 2) Float bins in parallel (optional stretch); never block Play.
      const floats = await Promise.all(
        frames.map(async (f) => {
          if (!f.float_bin || !f.float_shape) return emptyFloat;
          try {
            const [h, w] = f.float_shape;
            const buf = await fetch(apiUrl(f.float_bin), {
              signal: AbortSignal.timeout(8_000),
            }).then((r) => r.arrayBuffer());
            const data = new Float32Array(buf);
            let flags: Int16Array | null = null;
            if (f.flags_bin) {
              const fb = await fetch(apiUrl(f.flags_bin), {
                signal: AbortSignal.timeout(8_000),
              }).then((r) => r.arrayBuffer());
              flags = new Int16Array(fb);
            }
            return { data, flags, w, h };
          } catch {
            return emptyFloat;
          }
        }),
      );
      if (cancelled || sigAtStart !== framesSigRef.current) return;
      floatCacheRef.current = floats;
      setFloatFrames(floats);
      const all = floats.flatMap((f) => (f.data.length ? [f.data] : []));
      if (all.length) {
        const cat = new Float32Array(all.reduce((n, a) => n + a.length, 0));
        let o = 0;
        for (const a of all) {
          cat.set(a, o);
          o += a.length;
        }
        setSharedScale(percentileClip(cat, pctLo, pctHi));
      } else setSharedScale(null);
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally keyed by framesSig — not frames array identity / clip toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesSig, reducedMotion]);

  // Recompute shared stretch when clip percentiles change (keep loaded floats).
  useEffect(() => {
    const floats = floatCacheRef.current;
    const all = floats.flatMap((f) => (f.data.length ? [f.data] : []));
    if (!all.length) return;
    const cat = new Float32Array(all.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of all) {
      cat.set(a, o);
      o += a.length;
    }
    setSharedScale(percentileClip(cat, pctLo, pctHi));
  }, [pctLo, pctHi]);

  const onEpochChangeRef = useRef(onEpochChange);
  onEpochChangeRef.current = onEpochChange;
  useEffect(() => {
    // Defer so App setState never lands inside BlinkPlayer's render phase.
    const t = window.setTimeout(() => onEpochChangeRef.current?.(index), 0);
    return () => window.clearTimeout(t);
  }, [index]);

  useEffect(() => {
    if (!playing || frames.length < 2 || !assetsReady) return;
    const rate = Math.min(Math.max(hz, 0.2), MAX_HZ);
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, 1000 / rate);
    return () => window.clearInterval(id);
  }, [playing, hz, frames.length, assetsReady]);

  // Space = temporary pan
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === canvasRef.current) {
        // play/pause handled on canvas keydown; global Space for pan when not on canvas
      }
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        setSpacePan(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpacePan(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const drawFrameToCtx = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      css: number,
      viewRect: ViewRect,
      frameIndex: number,
      opts?: { drawOverlays?: boolean; drawHud?: boolean },
    ) => {
      const frame = frames[frameIndex];
      const img = images[frameIndex];
      const ff = floatFrames[frameIndex];
      const drawOverlays = opts?.drawOverlays !== false;
      const drawHud = opts?.drawHud !== false;
      const nativeW = ff?.w || img?.naturalWidth || nativeSize.width;
      const nativeH = ff?.h || img?.naturalHeight || nativeSize.height;
      const v = normalizeRect(viewRect);

      ctx.fillStyle = "#0a1020";
      ctx.fillRect(0, 0, css, css);

      // Source rect in native pixels → destination. Prefer integer CSS px / native px
      // when True pixels is on so edges stay crisp (no fractional upscale blur).
      const sx = v.x0;
      const sy = v.y0;
      const sw = Math.max(v.x1 - v.x0, 1e-6);
      const sh = Math.max(v.y1 - v.y0, 1e-6);
      let dx = 0;
      let dy = 0;
      let dw = css;
      let dh = css;
      if (!interp) {
        const intScale = Math.max(1, Math.floor(css / Math.max(sw, sh)));
        dw = Math.round(sw) * intScale;
        dh = Math.round(sh) * intScale;
        dx = Math.floor((css - dw) / 2);
        dy = Math.floor((css - dh) / 2);
      }

      ctx.imageSmoothingEnabled = interp;
      ctx.imageSmoothingQuality = interp ? "high" : "low";
      if (ff && ff.data.length === ff.w * ff.h && sharedScale) {
        const id = stretchToRgba(ff.data, ff.w, ff.h, {
          mode: stretchMode,
          vmin: sharedScale[0],
          vmax: sharedScale[1],
          flags: ff.flags,
          colormap,
          showFlags,
        });
        const off = document.createElement("canvas");
        off.width = ff.w;
        off.height = ff.h;
        off.getContext("2d")!.putImageData(id, 0, 0);
        ctx.drawImage(off, sx, sy, sw, sh, dx, dy, dw, dh);
      } else if (img && img.naturalWidth > 0) {
        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      }

      if (drawOverlays) {
        if (timePoint) {
          const wcs = frameWcs(frame, fieldRa, fieldDec, pixelScaleArcsec);
          if (wcs) { ctx.strokeStyle = "rgba(238,188,96,.75)"; ctx.lineWidth = 1.5; ctx.beginPath(); let started = false;
            for (const sky of timeTrail) { const pixel = worldToPixel(wcs, sky.ra, sky.dec); const point = imageToCanvas(pixel.x, pixel.y, v, css); if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue; if (!started) {ctx.moveTo(point.x,point.y); started=true;} else ctx.lineTo(point.x,point.y); } ctx.stroke();
            const pos = worldToPixel(wcs, timePoint.ra, timePoint.dec); const pt = imageToCanvas(pos.x, pos.y, v, css);
            if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) { ctx.strokeStyle = "#eebc60"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pt.x, pt.y, 10, 0, 2 * Math.PI); ctx.stroke(); ctx.fillStyle = "#eebc60"; ctx.font = "11px monospace"; ctx.fillText(`${timeLabel} ${timePoint.decimal_year.toFixed(1)}`, pt.x + 12, pt.y); }
          }
        }
        const g = showGhost ? ghostForFrame(ghost, frame, frameIndex) : undefined;
        const gxy =
          g && nativeW > 0 && g.x_pix != null && g.y_pix != null
            ? imageToCanvas(g.x_pix, g.y_pix, v, css)
            : null;

        // Historical catalog markers (Gaia / WISE designation) + arrow to predicted epoch.
        if (showGhost && historicalMarkers.length && nativeW > 0) {
          for (const m of historicalMarkers) {
            if (m.x_pix == null || m.y_pix == null) continue;
            const mxy = imageToCanvas(m.x_pix, m.y_pix, v, css);
            ctx.strokeStyle = "#5ec8d8";
            ctx.fillStyle = "#5ec8d8";
            ctx.lineWidth = 2;
            const arm = 8;
            ctx.beginPath();
            ctx.moveTo(mxy.x - arm, mxy.y);
            ctx.lineTo(mxy.x + arm, mxy.y);
            ctx.moveTo(mxy.x, mxy.y - arm);
            ctx.lineTo(mxy.x, mxy.y + arm);
            ctx.stroke();
            ctx.font = "11px IBM Plex Mono, monospace";
            ctx.fillText(m.label, mxy.x + 10, mxy.y - 10);

            if (gxy && g) {
              ctx.strokeStyle = "#f0c24b";
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(mxy.x, mxy.y);
              ctx.lineTo(gxy.x, gxy.y);
              ctx.stroke();
              const ang = Math.atan2(gxy.y - mxy.y, gxy.x - mxy.x);
              ctx.beginPath();
              ctx.moveTo(gxy.x, gxy.y);
              ctx.lineTo(
                gxy.x - 10 * Math.cos(ang - 0.4),
                gxy.y - 10 * Math.sin(ang - 0.4),
              );
              ctx.lineTo(
                gxy.x - 10 * Math.cos(ang + 0.4),
                gxy.y - 10 * Math.sin(ang + 0.4),
              );
              ctx.closePath();
              ctx.fillStyle = "#f0c24b";
              ctx.fill();

              const midX = (mxy.x + gxy.x) / 2;
              const midY = (mxy.y + gxy.y) / 2;
              const offA =
                g.offset_from_catalog_arcsec != null
                  ? `${g.offset_from_catalog_arcsec.toFixed(1)}″`
                  : "offset not computed";
              const offP =
                g.offset_from_catalog_pix != null
                  ? `${g.offset_from_catalog_pix.toFixed(1)} px`
                  : "";
              const unc =
                g.offset_uncertainty_arcsec != null
                  ? ` ± ${g.offset_uncertainty_arcsec.toFixed(1)}″`
                  : ` (${g.offset_uncertainty_note || "no uncertainty available"})`;
              ctx.fillStyle = "#f0c24b";
              ctx.font = "11px IBM Plex Mono, monospace";
              ctx.fillText(`Δ ${offA}${offP ? ` ≈ ${offP}` : ""}${unc}`, midX + 6, midY - 4);
            }
          }
        }

        if (gxy) {
          ctx.strokeStyle = "#f0c24b";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(gxy.x, gxy.y, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.font = "12px IBM Plex Mono, monospace";
          ctx.fillStyle = "#f0c24b";
          ctx.fillText("predicted @ epoch", gxy.x + 14, gxy.y - 8);
        }

        // Change-slider aperture (follows zoom/pan via imageToCanvas)
        if (aperture && Number.isFinite(aperture.x) && Number.isFinite(aperture.y)) {
          const c = imageToCanvas(aperture.x, aperture.y, v, css);
          const rCss = aperture.r * (css / Math.max(v.x1 - v.x0, 1e-6));
          ctx.strokeStyle = "#5ec8d8";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(c.x, c.y, Math.max(rCss, 4), 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Target marker (solid cyan circle) — always on top when we know the pixel
        {
          const fr = frame;
          const wcsMark = frameWcs(fr, fieldRa, fieldDec, pixelScaleArcsec);
          let tx: number | null =
            fr?.target_x_pix != null && Number.isFinite(fr.target_x_pix)
              ? Number(fr.target_x_pix)
              : null;
          let ty: number | null =
            fr?.target_y_pix != null && Number.isFinite(fr.target_y_pix)
              ? Number(fr.target_y_pix)
              : null;
          // Fall back to field center / WCS so every known target keeps a ring
          if ((tx == null || ty == null) && wcsMark && fieldRa != null && fieldDec != null) {
            const p = worldToPixel(wcsMark, fieldRa, fieldDec);
            tx = p.x;
            ty = p.y;
          }
          if ((tx == null || ty == null) && nativeW > 0 && nativeH > 0) {
            tx = (nativeW - 1) / 2;
            ty = (nativeH - 1) / 2;
          }
          if (tx != null && ty != null && nativeW > 0) {
            const inside = pixelInside(tx, ty, nativeW, nativeH, 0);
            const cxy = imageToCanvas(tx, ty, v, css);
            ctx.setLineDash([]);
            ctx.strokeStyle = inside ? "#7dd3fc" : "#e07070";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(cxy.x, cxy.y, 12, 0, Math.PI * 2);
            ctx.stroke();
            const arm = 6;
            ctx.beginPath();
            ctx.moveTo(cxy.x - arm, cxy.y);
            ctx.lineTo(cxy.x + arm, cxy.y);
            ctx.moveTo(cxy.x, cxy.y - arm);
            ctx.lineTo(cxy.x, cxy.y + arm);
            ctx.stroke();
            ctx.font = "12px IBM Plex Mono, monospace";
            ctx.fillStyle = inside ? "#7dd3fc" : "#e07070";
            ctx.fillText(
              inside ? "target" : "outside this frame",
              cxy.x + 14,
              cxy.y + 4,
            );
          }
        }

        // Centroid trail for kept frames
        if (trail.length >= 1) {
          const pts = trail.map((t) => ({
            ...t,
            c: imageToCanvas(t.x, t.y, v, css),
          }));
          ctx.lineWidth = 2;
          ctx.beginPath();
          pts.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.c.x, p.c.y);
            else ctx.lineTo(p.c.x, p.c.y);
          });
          ctx.strokeStyle = "#7ddea0";
          ctx.stroke();
          pts.forEach((p, i) => {
            const col = trailColor(pts.length <= 1 ? 0 : i / (pts.length - 1));
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(p.c.x, p.c.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#e7eefc";
            ctx.font = "10px IBM Plex Mono, monospace";
            ctx.fillText(String(p.index), p.c.x + 6, p.c.y - 4);
          });
          if (pts.length >= 2) {
            const a = pts[0].c;
            const b = pts[pts.length - 1].c;
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            ctx.strokeStyle = "#e7eefc";
            ctx.fillStyle = "#e7eefc";
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4));
            ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4));
            ctx.closePath();
            ctx.fill();
          }
        }

        // Optional predicted track comparison (dashed)
        if (predictedTrail.length >= 2) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = "#f0c24b";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          predictedTrail.forEach((t, i) => {
            const c = imageToCanvas(t.x, t.y, v, css);
            if (i === 0) ctx.moveTo(c.x, c.y);
            else ctx.lineTo(c.x, c.y);
          });
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Scale bar (bottom-left)
      if (drawHud) {
        const fov = fovArcsec(v);
        const barArcsec = niceScale(fov.w / 4);
        const barPx = (barArcsec / pixelScaleArcsec) * (css / sw);
        ctx.fillStyle = "rgba(6,12,24,0.75)";
        ctx.fillRect(8, css - 52, Math.max(barPx + 16, 80), 20);
        ctx.strokeStyle = "#e8eefc";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(16, css - 42);
        ctx.lineTo(16 + barPx, css - 42);
        ctx.stroke();
        ctx.fillStyle = "#e8eefc";
        ctx.font = "11px IBM Plex Mono, monospace";
        ctx.fillText(`${barArcsec}″`, 16, css - 46);

        ctx.fillStyle = "rgba(6,12,24,0.7)";
        ctx.fillRect(0, css - 28, css, 28);
        ctx.fillStyle = "#e8eefc";
        ctx.font = "12px IBM Plex Sans, sans-serif";
        const label = frame
          ? `${frame.time_iso || `MJD ${frame.mjd.toFixed(3)}`} · ${frame.bandpass}` +
            (frame.central_wavelength_um != null
              ? ` · λ≈${frame.central_wavelength_um.toFixed(2)} µm`
              : "") +
            ` · FOV ${fov.w.toFixed(0)}×${fov.h.toFixed(0)}″`
          : "No frame";
        ctx.fillText(label, 12, css - 10);
        if (backgroundNote) {
          ctx.fillStyle = "#9db0d0";
          ctx.font = "10px IBM Plex Mono, monospace";
          ctx.fillText(backgroundNote.slice(0, 72), 12, css - 30);
        }
      }

      // Rubber-band / keyboard selection overlay in image space
      const box = dragBox || kbBox;
      if (box && drawHud) {
        const n = normalizeRect(box);
        const a = imageToCanvas(n.x0, n.y0, v, css);
        const b = imageToCanvas(n.x1, n.y1, v, css);
        ctx.fillStyle = "rgba(240,194,75,0.18)";
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.strokeStyle = "#f0c24b";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.fillStyle = "#f0c24b";
        ctx.font = "11px IBM Plex Mono, monospace";
        ctx.fillText(selectionReadout(n), a.x + 4, Math.max(14, a.y - 4));
      }
    },
    [
      aperture,
      backgroundNote,
      colormap,
      dragBox,
      fieldDec,
      fieldRa,
      floatFrames,
      frames,
      ghost,
      historicalMarkers,
      images,
      interp,
      kbBox,
      markFieldCenter,
      nativeSize.height,
      nativeSize.width,
      pixelScaleArcsec,
      predictedTrail,
      sharedScale,
      showFlags,
      showGhost,
      stretchMode,
      trail,
      timePoint,
      timeLabel,
      timeTrail,
    ],
  );

  useEffect(() => {
    if (!timeCenter || !timePoint) return;
    const wcs = frameWcs(frames[index], fieldRa, fieldDec, pixelScaleArcsec);
    if (!wcs) return;
    const pos = worldToPixel(wcs, timePoint.ra, timePoint.dec);
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    const half = Math.max(8, Math.min(nativeSize.width, nativeSize.height) / 8);
    commitView({x0:pos.x-half,y0:pos.y-half,x1:pos.x+half,y1:pos.y+half}, true);
    // Trigger only when requested, not on each animation tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeCenter]);

  const goToTarget = () => {
    const fr = frames[index];
    let tx = fr?.target_x_pix;
    let ty = fr?.target_y_pix;
    const wcs = frameWcs(fr, fieldRa, fieldDec, pixelScaleArcsec);
    if ((tx == null || ty == null) && wcs && fieldRa != null && fieldDec != null) {
      const p = worldToPixel(wcs, fieldRa, fieldDec);
      tx = p.x;
      ty = p.y;
    }
    if (tx == null || ty == null || !Number.isFinite(tx) || !Number.isFinite(ty)) return;
    const half = Math.max(8, Math.min(nativeSize.width, nativeSize.height) / 8);
    const next = clampRect(
      {
        x0: tx - half,
        y0: ty - half,
        x1: tx + half,
        y1: ty + half,
      },
      nativeSize,
    );
    commitView(expandToAspect(next, aspect, nativeSize), true);
  };

  const commitDisplay = useCallback(
    (
      patch: Partial<{
        stretch: StretchMode;
        clipLo: number;
        clipHi: number;
        interp: boolean;
        cmap: Colormap;
        showFlags: boolean;
      }>,
    ) => {
      const next = {
        stretch: patch.stretch ?? stretchMode,
        clipLo: patch.clipLo ?? pctLo,
        clipHi: patch.clipHi ?? pctHi,
        interp: patch.interp ?? interp,
        cmap: patch.cmap ?? colormap,
        showFlags: patch.showFlags ?? showFlags,
      };
      onDisplayCommit?.(next);
    },
    [colormap, interp, onDisplayCommit, pctHi, pctLo, showFlags, stretchMode],
  );

  const applyArchiveLook = useCallback(() => {
    setStretchMode(ARCHIVE_LOOK.stretch);
    setPctLo(ARCHIVE_LOOK.clipLo);
    setPctHi(ARCHIVE_LOOK.clipHi);
    setColormap(ARCHIVE_LOOK.cmap);
    setInterp(ARCHIVE_LOOK.interp);
    setShowFlags(ARCHIVE_LOOK.showFlags);
    onStretchCommit?.(ARCHIVE_LOOK.stretch);
    commitDisplay({ ...ARCHIVE_LOOK });
  }, [commitDisplay, onStretchCommit]);

  // Main + optional split + minimap draw
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = CSS_CANVAS;
    c.width = Math.round(css * dpr);
    c.height = Math.round(css * dpr);
    c.style.width = `${css}px`;
    c.style.height = `${css}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Zoom panel layout: left = full field, right canvas = zoomed region
    const mainView = splitPanel ? fullImageRect(nativeSize) : displayView;
    drawFrameToCtx(ctx, css, mainView, index);

    const mini = miniRef.current;
    if (mini) {
      const mctx = mini.getContext("2d");
      if (mctx) {
        const ms = 120;
        const mdpr = Math.min(window.devicePixelRatio || 1, 2);
        mini.width = Math.round(ms * mdpr);
        mini.height = Math.round(ms * mdpr);
        mini.style.width = `${ms}px`;
        mini.style.height = `${ms}px`;
        mctx.setTransform(mdpr, 0, 0, mdpr, 0, 0);
        const full = fullImageRect(nativeSize);
        drawFrameToCtx(mctx, ms, full, index, { drawOverlays: false, drawHud: false });
        const v = normalizeRect(displayView);
        const rx = (v.x0 / nativeSize.width) * ms;
        const ry = (v.y0 / nativeSize.height) * ms;
        const rw = (rectW(v) / nativeSize.width) * ms;
        const rh = (rectH(v) / nativeSize.height) * ms;
        mctx.strokeStyle = "#f0c24b";
        mctx.lineWidth = 1.5;
        mctx.strokeRect(rx, ry, rw, rh);
      }
    }
  }, [displayView, drawFrameToCtx, index, nativeSize, splitPanel]);

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const selectStart = useRef<{ x: number; y: number } | null>(null);
  const dragBoxRef = useRef<ViewRect | null>(null);
  const panStart = useRef<{ x: number; y: number; view: ViewRect } | null>(null);
  const pinchStart = useRef<{ dist: number; view: ViewRect } | null>(null);

  const cssPos = (e: React.PointerEvent | PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * CSS_CANVAS,
      y: ((e.clientY - r.top) / r.height) * CSS_CANVAS,
    };
  };

  const effectiveTool = (): ToolMode => {
    if (spacePan) return "pan";
    return tool;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const c = canvasRef.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    const p = cssPos(e);
    pointers.current.set(e.pointerId, p);

    if (e.button === 1 || effectiveTool() === "pan") {
      panStart.current = { x: p.x, y: p.y, view: normalizeRect(displayViewRef.current) };
      selectStart.current = null;
      return;
    }

    if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStart.current = { dist, view: normalizeRect(displayViewRef.current) };
      selectStart.current = null;
      return;
    }

    selectStart.current = p;
    const img = canvasToImage(p.x, p.y, displayViewRef.current);
    const box = { x0: img.x, y0: img.y, x1: img.x, y1: img.y };
    dragBoxRef.current = box;
    setDragBox(box);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = cssPos(e);
    pointers.current.set(e.pointerId, p);

    // Cursor readout — per-frame WCS (0-based pixels ↔ sky)
    const imgPt = canvasToImage(p.x, p.y, displayViewRef.current);
    const fr = frames[index];
    const wcs = frameWcs(fr, fieldRa, fieldDec, pixelScaleArcsec);
    if (wcs) {
      const sky = pixelToWorld(wcs, imgPt.x, imgPt.y);
      setCursorReadout(
        `RA ${sky.ra.toFixed(5)}°  Dec ${sky.dec.toFixed(5)}° · pix (${imgPt.x.toFixed(1)}, ${imgPt.y.toFixed(1)}) · WCS · no uncertainty available`,
      );
    } else {
      setCursorReadout(`pix (${imgPt.x.toFixed(1)}, ${imgPt.y.toFixed(1)})`);
    }

    if (pointers.current.size === 2 && pinchStart.current) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const factor = dist / Math.max(pinchStart.current.dist, 1);
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
      const focus = canvasToImage(mid.x, mid.y, pinchStart.current.view);
      const next = zoomAtPoint(
        pinchStart.current.view,
        focus.x,
        focus.y,
        Math.min(Math.max(factor, 0.25), 8),
        nativeSize,
        aspect,
      );
      stackRef.current.replaceTop(next);
      displayViewRef.current = next;
      setDisplayView(next);
      setView(next);
      return;
    }

    if (panStart.current) {
      const v0 = panStart.current.view;
      const sw = rectW(v0);
      const dxImg = -((p.x - panStart.current.x) / CSS_CANVAS) * sw;
      const dyImg = -((p.y - panStart.current.y) / CSS_CANVAS) * sw;
      const next = panView(v0, dxImg, dyImg, nativeSize);
      stackRef.current.replaceTop(next);
      displayViewRef.current = next;
      setDisplayView(next);
      setView(next);
      return;
    }

    if (selectStart.current) {
      const a = canvasToImage(selectStart.current.x, selectStart.current.y, displayViewRef.current);
      const b = canvasToImage(p.x, p.y, displayViewRef.current);
      const box = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      dragBoxRef.current = box;
      setDragBox(box);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;

    if (panStart.current) {
      panStart.current = null;
      // Push current pan into view state so URL sync effect runs
      setView(normalizeRect(displayViewRef.current));
      selectStart.current = null;
      dragBoxRef.current = null;
      setDragBox(null);
      return;
    }

    if (selectStart.current && dragBoxRef.current) {
      const raw = normalizeRect(dragBoxRef.current);
      const start = selectStart.current;
      dragBoxRef.current = null;
      setDragBox(null);
      selectStart.current = null;
      if (!meetsMinSize(raw)) {
        const imgPt = canvasToImage(start.x, start.y, displayViewRef.current);
        const frClick = frames[index];
        const wcsClick = frameWcs(frClick, fieldRa, fieldDec, pixelScaleArcsec);
        if (wcsClick && onSkyClick) {
          const sky = pixelToWorld(wcsClick, imgPt.x, imgPt.y);
          onSkyClick(sky.ra, sky.dec);
        }
        // Shift+click → always inspect; else pick-aperture wins; else inspect if wired.
        if (e.shiftKey && onInspectPixel) {
          onInspectPixel(imgPt.x, imgPt.y);
          setAnnounce(
            `Inspect pixel ${imgPt.x.toFixed(1)}, ${imgPt.y.toFixed(1)}.`,
          );
        } else if (pickAperture && onAperturePick) {
          onAperturePick(imgPt.x, imgPt.y);
          setAnnounce(
            `Aperture moved to pixel ${imgPt.x.toFixed(1)}, ${imgPt.y.toFixed(1)}. Scores will recompute.`,
          );
        } else if (onInspectPixel) {
          onInspectPixel(imgPt.x, imgPt.y);
          setAnnounce(
            `Inspect pixel ${imgPt.x.toFixed(1)}, ${imgPt.y.toFixed(1)}.`,
          );
        }
        return;
      }
      const expanded = expandToAspect(raw, aspect, nativeSize);
      commitView(expanded, true);
      return;
    }
    selectStart.current = null;
    dragBoxRef.current = null;
    setDragBox(null);
    panStart.current = null;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = cssPos(e as unknown as PointerEvent);
    const focus = canvasToImage(p.x, p.y, displayViewRef.current);
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const next = zoomAtPoint(displayViewRef.current, focus.x, focus.y, factor, nativeSize, aspect);
    stackRef.current.push(next);
    commitView(next, false);
  };

  const step = (dir: number) => {
    if (!frames.length) return;
    setPlaying(false);
    setIndex((i) => {
      const n = (i + dir + frames.length) % frames.length;
      onEpochCommit?.(n);
      return n;
    });
  };

  const togglePlay = () => {
    setPlaying((p) => {
      const next = !p;
      if (!next) onEpochCommit?.(index);
      return next;
    });
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Space = hold-to-pan (window listener); K = play/pause
    if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDragBox(null);
      setKbBox(null);
      zoomReset();
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      zoomBack();
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      zoomReset();
      return;
    }

    // Keyboard selection box
    const base =
      kbBox ||
      (() => {
        const v = normalizeRect(displayView);
        const w = Math.min(10, rectW(v) / 2);
        const cx = (v.x0 + v.x1) / 2;
        const cy = (v.y0 + v.y1) / 2;
        return { x0: cx - w / 2, y0: cy - w / 2, x1: cx + w / 2, y1: cy + w / 2 };
      })();

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && e.shiftKey) {
      // already handled play steppers without shift
    }
    const stepPix = 1;
    if (e.key === "ArrowUp" && !e.metaKey) {
      // without modifiers after play keys — move kb box when focused with alt?
    }
    // Dedicated: Alt+arrows move selection; +/− resize; Enter zooms
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, 0, -stepPix, nativeSize), nativeSize));
      return;
    }
    if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, 0, stepPix, nativeSize), nativeSize));
      return;
    }
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, -stepPix, 0, nativeSize), nativeSize));
      return;
    }
    if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, stepPix, 0, nativeSize), nativeSize));
      return;
    }
    // Spec: arrow keys move selection box when in select mode (and not conflicting)
    if (tool === "select" && !e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key) === false) {
      // keep left/right for frame step
    }
    if (tool === "select" && e.key === "ArrowUp" && e.ctrlKey) {
      e.preventDefault();
      setKbBox(clampRect(panView(base, 0, -stepPix, nativeSize), nativeSize));
      return;
    }
    if (tool === "select" && e.key === "ArrowDown" && e.ctrlKey) {
      e.preventDefault();
      setKbBox(clampRect(panView(base, 0, stepPix, nativeSize), nativeSize));
      return;
    }
    // Spec wants arrows to move box — use Ctrl+arrows for box, plain for frames.
    // Also support i/j/k/l style: use [ ] for resize and wasd when Shift
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      const n = normalizeRect(base);
      const cx = (n.x0 + n.x1) / 2;
      const cy = (n.y0 + n.y1) / 2;
      const w = rectW(n) * 1.15;
      setKbBox(
        clampRect(
          expandToAspect(
            { x0: cx - w / 2, y0: cy - w / 2, x1: cx + w / 2, y1: cy + w / 2 },
            aspect,
            nativeSize,
          ),
          nativeSize,
        ),
      );
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      const n = normalizeRect(base);
      const cx = (n.x0 + n.x1) / 2;
      const cy = (n.y0 + n.y1) / 2;
      const w = Math.max(MIN_BOX, rectW(n) / 1.15);
      setKbBox(
        clampRect(
          expandToAspect(
            { x0: cx - w / 2, y0: cy - w / 2, x1: cx + w / 2, y1: cy + w / 2 },
            aspect,
            nativeSize,
          ),
          nativeSize,
        ),
      );
      return;
    }
    if (e.key === "Enter" && kbBox) {
      e.preventDefault();
      if (meetsMinSize(kbBox)) {
        commitView(expandToAspect(kbBox, aspect, nativeSize), true);
        setKbBox(null);
      }
      return;
    }
    // Move selection with Shift+Arrows (frame step without shift)
    if (e.shiftKey && e.key === "ArrowUp") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, 0, -stepPix, nativeSize), nativeSize));
    }
    if (e.shiftKey && e.key === "ArrowDown") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, 0, stepPix, nativeSize), nativeSize));
    }
    if (e.shiftKey && e.key === "ArrowLeft") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, -stepPix, 0, nativeSize), nativeSize));
    }
    if (e.shiftKey && e.key === "ArrowRight") {
      e.preventDefault();
      setKbBox(clampRect(panView(base, stepPix, 0, nativeSize), nativeSize));
    }
  };

  const onMiniPointer = (e: React.PointerEvent) => {
    const mini = miniRef.current;
    if (!mini) return;
    const r = mini.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * nativeSize.width;
    const my = ((e.clientY - r.top) / r.height) * nativeSize.height;
    const v = normalizeRect(displayView);
    const w = rectW(v);
    const h = rectH(v);
    const next = clampRect(
      { x0: mx - w / 2, y0: my - h / 2, x1: mx + w / 2, y1: my + h / 2 },
      nativeSize,
    );
    stackRef.current.replaceTop(next);
    displayViewRef.current = next;
    setDisplayView(next);
    setView(next);
  };

  const fov = fovArcsec(displayView);

  return (
    <div className="blink" role="region" aria-label="SPHEREx blink player">
      <div className={`blink-stage${splitPanel ? " split" : ""}`}>
        <div className="blink-main">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className={interp ? "smooth-interp" : undefined}
            data-testid="blink-canvas"
            data-frame-index={index}
            data-view={JSON.stringify(normalizeRect(view))}
            aria-label="Sky cutout blink canvas. Drag to select-zoom. Space held pans. Shift+arrows move selection. Enter zooms. Esc resets."
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(e) => {
              e.preventDefault();
              zoomReset();
            }}
          />
          <canvas
            ref={miniRef}
            className="blink-minimap"
            data-testid="blink-minimap"
            aria-label="Minimap of full field"
            onPointerDown={onMiniPointer}
            onPointerMove={(e) => {
              if (e.buttons) onMiniPointer(e);
            }}
          />
        </div>
        {splitPanel && (
          <SplitZoomCanvas
            draw={drawFrameToCtx}
            view={displayView}
            index={index}
          />
        )}
      </div>

      <details className="tools-menu" open={expanded || undefined}>
        <summary>⋯ Image tools</summary>
      <div className="blink-toolbar" role="toolbar" aria-label="Zoom tools">
        <button
          type="button"
          aria-pressed={tool === "select"}
          onClick={() => setTool("select")}
          title="Drag a box to zoom"
        >
          Select
        </button>
        <button
          type="button"
          aria-pressed={tool === "pan"}
          onClick={() => setTool("pan")}
          title="Drag to pan (or hold Space)"
        >
          Pan
        </button>
        <button
          type="button"
          onClick={zoomBack}
          disabled={stackRef.current.depth() <= 1}
          data-can-back={stackRef.current.depth() > 1 ? "1" : "0"}
          title="Undo last zoom"
        >
          Back
        </button>
        <button type="button" onClick={zoomReset} title="Reset zoom (Esc / 0 / double-click)">
          Reset
        </button>
        <button
          type="button"
          data-testid="blink-goto-target"
          onClick={goToTarget}
          title="Center on this frame’s target pixel"
        >
          Go to target
        </button>
        <button
          type="button"
          aria-pressed={splitPanel}
          onClick={() => setSplitPanel((s) => !s)}
          title="Full view + zoomed panel"
        >
          Zoom panel
        </button>
        <button
          type="button"
          disabled={offline || rectIsFull(view, nativeSize)}
          title={
            offline
              ? "Re-fetch disabled offline"
              : "Ask backend for a cutout of this region (does not add resolution)"
          }
          onClick={() => {
            if (offline || rectIsFull(view, nativeSize)) return;
            onRefetchRegion?.(normalizeRect(view));
          }}
        >
          Re-fetch this area
        </button>
      </div>
      </details>

      <div className="blink-controls">
        <button
          type="button"
          data-testid="blink-play"
          className="btn-blink"
          onClick={togglePlay}
          aria-pressed={playing}
          aria-label={playing ? "Pause" : assetsReady ? "Play" : "Loading…"}
          disabled={!assetsReady || frames.length < 2}
        >
          {playing ? "❚❚ Pause" : assetsReady ? "▶ Blink" : "Loading…"}
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
              const n = Number(e.target.value);
              setPlaying(false);
              setIndex(n);
              onEpochCommit?.(n);
            }}
          />
        )}
        <button type="button" data-testid="blink-step-prev" onClick={() => step(-1)}>
          Step −
        </button>
        <button type="button" data-testid="blink-step-next" onClick={() => step(1)}>
          Step +
        </button>
        <SliderWithInput
          id="blink-speed"
          label="Blink speed"
          unit="Hz"
          min={0.2}
          max={MAX_HZ}
          step={0.1}
          decimals={1}
          value={Math.min(hz, MAX_HZ)}
          onChange={setHz}
          clampNote={`Capped at ${MAX_HZ} Hz (flash-rate safety limit)`}
        />
        <SliderWithInput
          id="blink-zoom"
          label="Zoom"
          unit="×"
          min={1}
          max={16}
          step={0.1}
          decimals={1}
          allowBeyondMax
          hardMax={ZOOM_HARD_MAX}
          value={Math.min(ZOOM_HARD_MAX, nativeSize.width / Math.max(rectW(displayView), 1))}
          onChange={(factor) => {
                            const full = fullImageRect(nativeSize);
              const focus = {
                x: (displayView.x0 + displayView.x1) / 2,
                y: (displayView.y0 + displayView.y1) / 2,
              };
              const targetW = nativeSize.width / factor;
              const next = clampRect(
                expandToAspect(
                  {
                    x0: focus.x - targetW / 2,
                    y0: focus.y - targetW / 2,
                    x1: focus.x + targetW / 2,
                    y1: focus.y + targetW / 2,
                  },
                  aspect,
                  nativeSize,
                ),
                nativeSize,
              );
              stackRef.current.replaceTop(factor <= 1.05 ? full : next);
              commitView(factor <= 1.05 ? full : next, false);
          }}
        />
      </div>
      <details className="tools-menu" open={expanded || undefined}>
        <summary>Display settings</summary>
      <div className="blink-controls">
        <button
          type="button"
          className="btn ghost"
          data-testid="archive-look-preset"
          onClick={applyArchiveLook}
          title="Grayscale, asinh clip 1–99.5%, true pixels, no flag hatch"
        >
          Match archive look
        </button>
        <label>
          Stretch
          <select
            value={stretchMode}
            onChange={(e) => {
              const m = e.target.value as StretchMode;
              setStretchMode(m);
              onStretchCommit?.(m);
              commitDisplay({ stretch: m });
            }}
          >
            <option value="asinh">asinh (default)</option>
            <option value="linear">linear</option>
            <option value="log">log</option>
          </select>
        </label>
        <SliderWithInput
          id="blink-clip-lo"
          label="Clip lo"
          unit="%"
          min={0}
          max={20}
          step={0.5}
          decimals={1}
          value={pctLo}
          onChange={(v) => {
            setPctLo(v);
            commitDisplay({ clipLo: v });
          }}
        />
        <SliderWithInput
          id="blink-clip-hi"
          label="Clip hi"
          unit="%"
          min={80}
          max={100}
          step={0.5}
          decimals={1}
          value={pctHi}
          onChange={(v) => {
            setPctHi(v);
            commitDisplay({ clipHi: v });
          }}
        />
        <label>
          Colormap
          <select
            value={colormap}
            aria-label="Colormap"
            onChange={(e) => {
              const m = e.target.value as Colormap;
              setColormap(m);
              commitDisplay({ cmap: m });
            }}
          >
            <option value="gray">grayscale</option>
            <option value="gray_inv">inverted</option>
            <option value="viridis">viridis (colorblind-safe)</option>
          </select>
        </label>
        <fieldset className="interp-toggle" aria-label="Interpolation">
          <legend>Interpolation</legend>
          <label className="check">
            <input
              type="radio"
              name="interp"
              checked={!interp}
              onChange={() => {
                setInterp(false);
                commitDisplay({ interp: false });
              }}
            />
            True pixels (default, nearest-neighbor)
          </label>
          <label className="check">
            <input
              type="radio"
              name="interp"
              checked={interp}
              onChange={() => {
                setInterp(true);
                commitDisplay({ interp: true });
              }}
            />
            Smooth — interpolated, not real resolution
          </label>
        </fieldset>
        <label className="check" data-testid="show-flagged-pixels">
          <input
            type="checkbox"
            checked={showFlags}
            onChange={(e) => {
              const on = e.target.checked;
              setShowFlags(on);
              commitDisplay({ showFlags: on });
            }}
          />
          Show flagged pixels
        </label>
        {showFlags ? (
          <details className="flags-legend-panel" open>
            <summary>
              <span className="flag-swatch" aria-hidden="true" /> Purple hatch overlay (NaN + bad
              FLAGS; not SOURCE / FULLSAMPLE)
            </summary>
            <ul className="hint mono flags-bit-list">
              {flaggedPixelLegend().map(({ bit, name }) => (
                <li key={name}>
                  bit {bit}: {name}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="hint" role="note">
            Archive look: NaN and OVERFLOW/BLOOM → plain black. Shared asinh clip {pctLo}–{pctHi}%
            across blink frames (display only).
          </p>
        )}
      </div>
      </details>

      <p
        className="hint"
        data-testid="blink-status"
        data-obs-id={frames[index]?.obs_id ?? ""}
        data-epoch-index={index}
        data-epoch-count={frames.length}
      >
        Epoch {index + 1} of {frames.length}
        {frames[index]?.time_iso ? ` · ${frames[index]!.time_iso.slice(0, 10)}` : ""}
        {expanded && frames[index]?.obs_id ? ` · ${frames[index]!.obs_id}` : ""}
        {expanded && frames[index] ? ` · D${frames[index]!.detector}` : ""}
        {expanded && frames[index]?.central_wavelength_um != null
          ? ` · λ ${Number(frames[index]!.central_wavelength_um).toFixed(3)} µm`
          : ""}
        {expanded ? ` · FOV ${fov.w.toFixed(1)}×${fov.h.toFixed(1)}″` : ""}
        {!assetsReady ? " · preloading all epochs…" : ""}
      </p>
      <p className="hint" data-testid="cursor-readout">
        {cursorReadout}
      </p>
      <div className="sr-only" aria-live="polite" data-testid="zoom-announce">
        {announce}
      </div>
      {frames[index]?.is_synthetic && (
        <div className="badge synth" role="status">
          SIMULATED / TEST DATA
        </div>
      )}
    </div>
  );
}

const MIN_BOX = 3;

function SplitZoomCanvas({
  draw,
  view,
  index,
}: {
  draw: (
    ctx: CanvasRenderingContext2D,
    css: number,
    viewRect: ViewRect,
    frameIndex: number,
    opts?: { drawOverlays?: boolean; drawHud?: boolean },
  ) => void;
  view: ViewRect;
  index: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    node.width = Math.round(CSS_CANVAS * dpr);
    node.height = Math.round(CSS_CANVAS * dpr);
    node.style.width = `${CSS_CANVAS}px`;
    node.style.height = `${CSS_CANVAS}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, CSS_CANVAS, view, index);
  }, [draw, view, index]);
  return (
    <canvas
      ref={ref}
      className="blink-split"
      data-testid="blink-split"
      aria-label="Zoomed region panel"
    />
  );
}

function rectW(r: ViewRect): number {
  return Math.abs(r.x1 - r.x0);
}
function rectH(r: ViewRect): number {
  return Math.abs(r.y1 - r.y0);
}
function rectIsFull(r: ViewRect, bounds: { width: number; height: number }): boolean {
  const n = normalizeRect(r);
  return (
    n.x0 <= 0.5 &&
    n.y0 <= 0.5 &&
    n.x1 >= bounds.width - 0.5 &&
    n.y1 >= bounds.height - 0.5
  );
}
function niceScale(raw: number): number {
  if (raw <= 0) return 6.15;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return nice * pow;
}
