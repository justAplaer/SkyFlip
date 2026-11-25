import { useCallback, useEffect, useRef, useState } from "react";
import type { PixelRect } from "../lib/highlightMath";
import { normalizeRect } from "../lib/highlightMath";

interface Props {
  imageUrl?: string;
  width: number;
  height: number;
  rect: PixelRect | null;
  onChange: (r: PixelRect | null) => void;
  disabled?: boolean;
  label?: string;
}

const CSS = 280;

/** Draw / move / resize a translucent blue highlight rectangle on an image. */
export function HighlightPad({
  imageUrl,
  width,
  height,
  rect,
  onChange,
  disabled,
  label,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{
    mode: "draw" | "move" | "resize";
    start: { x: number; y: number };
    orig: PixelRect | null;
  } | null>(null);
  const [announce, setAnnounce] = useState("");

  const toImage = useCallback(
    (cx: number, cy: number) => ({
      x: (cx / CSS) * width,
      y: (cy / CSS) * height,
    }),
    [width, height],
  );

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(CSS * dpr);
    c.height = Math.round(CSS * dpr);
    c.style.width = `${CSS}px`;
    c.style.height = `${CSS}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a1020";
    ctx.fillRect(0, 0, CSS, CSS);
    const img = imgRef.current;
    if (img && img.naturalWidth) {
      ctx.drawImage(img, 0, 0, CSS, CSS);
    }
    if (rect) {
      const n = normalizeRect(rect);
      const x = (n.x0 / width) * CSS;
      const y = (n.y0 / height) * CSS;
      const w = ((n.x1 - n.x0) / width) * CSS;
      const h = ((n.y1 - n.y0) / height) * CSS;
      ctx.fillStyle = "rgba(64, 140, 255, 0.35)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#408cff";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      // resize handle
      ctx.fillStyle = "#408cff";
      ctx.fillRect(x + w - 8, y + h - 8, 8, 8);
      setAnnounce(
        `Highlight ${n.x0.toFixed(1)},${n.y0.toFixed(1)} to ${n.x1.toFixed(1)},${n.y1.toFixed(1)} pixels`,
      );
    }
  }, [rect, width, height]);

  useEffect(() => {
    if (!imageUrl) {
      imgRef.current = null;
      draw();
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imageUrl;
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    img.onerror = () => {
      imgRef.current = null;
      draw();
    };
  }, [imageUrl, draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    const c = canvasRef.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    const rectBox = c.getBoundingClientRect();
    const cx = e.clientX - rectBox.left;
    const cy = e.clientY - rectBox.top;
    const pt = toImage(cx, cy);
    if (rect) {
      const n = normalizeRect(rect);
      const hx = ((n.x1 / width) * CSS);
      const hy = ((n.y1 / height) * CSS);
      if (Math.hypot(cx - hx, cy - hy) < 14) {
        drag.current = { mode: "resize", start: pt, orig: n };
        return;
      }
      if (pt.x >= n.x0 && pt.x <= n.x1 && pt.y >= n.y0 && pt.y <= n.y1) {
        drag.current = { mode: "move", start: pt, orig: n };
        return;
      }
    }
    drag.current = {
      mode: "draw",
      start: pt,
      orig: { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y },
    };
    onChange({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || disabled) return;
    const c = canvasRef.current;
    if (!c) return;
    const rectBox = c.getBoundingClientRect();
    const pt = toImage(e.clientX - rectBox.left, e.clientY - rectBox.top);
    const d = drag.current;
    if (d.mode === "draw" && d.orig) {
      onChange({ x0: d.start.x, y0: d.start.y, x1: pt.x, y1: pt.y });
    } else if (d.mode === "move" && d.orig) {
      const dx = pt.x - d.start.x;
      const dy = pt.y - d.start.y;
      onChange({
        x0: d.orig.x0 + dx,
        y0: d.orig.y0 + dy,
        x1: d.orig.x1 + dx,
        y1: d.orig.y1 + dy,
      });
    } else if (d.mode === "resize" && d.orig) {
      onChange({ ...d.orig, x1: pt.x, y1: pt.y });
    }
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div className="highlight-pad">
      {label && <p className="hint">{label}</p>}
      <canvas
        ref={canvasRef}
        width={CSS}
        height={CSS}
        className="highlight-canvas"
        aria-label="Draw a blue rectangle around the object. Drag to move, corner to resize."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="row wrap" style={{ gap: "0.4rem" }}>
        <button type="button" disabled={disabled || !rect} onClick={() => onChange(null)}>
          Clear highlight
        </button>
        {rect && (
          <span className="mono hint">
            {normalizeRect(rect).x0.toFixed(1)},{normalizeRect(rect).y0.toFixed(1)} →{" "}
            {normalizeRect(rect).x1.toFixed(1)},{normalizeRect(rect).y1.toFixed(1)} px
          </span>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
