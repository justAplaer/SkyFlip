import { describe, expect, it } from "vitest";
import {
  clampRect,
  expandToAspect,
  fullImageRect,
  meetsMinSize,
  ZoomStack,
  canvasToImage,
  imageToCanvas,
  zoomAtPoint,
  panView,
  normalizeRect,
} from "./zoomMath";

const bounds = { width: 100, height: 80 };
const aspect = 480 / 480; // square canvas

describe("zoomMath", () => {
  it("expands a non-square drag to canvas aspect, centered", () => {
    const drag = { x0: 40, y0: 30, x1: 50, y1: 50 }; // 10×20
    const out = expandToAspect(drag, 1, bounds);
    expect(rectNearSquare(out)).toBe(true);
    expect((out.x0 + out.x1) / 2).toBeCloseTo(45, 5);
    expect((out.y0 + out.y1) / 2).toBeCloseTo(40, 5);
  });

  it("clamps to image bounds", () => {
    const out = clampRect({ x0: -10, y0: -5, x1: 30, y1: 35 }, bounds);
    expect(out.x0).toBeGreaterThanOrEqual(0);
    expect(out.y0).toBeGreaterThanOrEqual(0);
    expect(out.x1).toBeLessThanOrEqual(bounds.width);
    expect(out.y1).toBeLessThanOrEqual(bounds.height);
  });

  it("rejects selections smaller than 3×3 px", () => {
    expect(meetsMinSize({ x0: 10, y0: 10, x1: 12, y1: 12 })).toBe(false);
    expect(meetsMinSize({ x0: 10, y0: 10, x1: 13, y1: 13 })).toBe(true);
  });

  it("zoom stack push / back / reset", () => {
    const full = fullImageRect(bounds);
    const stack = new ZoomStack(full);
    expect(stack.canBack()).toBe(false);
    stack.push({ x0: 20, y0: 20, x1: 60, y1: 60 });
    expect(stack.canBack()).toBe(true);
    expect(stack.depth()).toBe(2);
    const back = stack.back();
    expect(back).toEqual(full);
    stack.push({ x0: 10, y0: 10, x1: 40, y1: 40 });
    stack.push({ x0: 15, y0: 15, x1: 30, y1: 30 });
    const reset = stack.reset(full);
    expect(reset).toEqual(full);
    expect(stack.depth()).toBe(1);
  });

  it("canvas↔image round-trip", () => {
    const view = { x0: 10, y0: 20, x1: 50, y1: 60 };
    const img = canvasToImage(240, 240, view, 480);
    const back = imageToCanvas(img.x, img.y, view, 480);
    expect(back.x).toBeCloseTo(240, 5);
    expect(back.y).toBeCloseTo(240, 5);
  });

  it("wheel zoom at point shrinks viewport", () => {
    const full = fullImageRect(bounds);
    const z = zoomAtPoint(full, 50, 40, 2, bounds, aspect);
    expect(z.x1 - z.x0).toBeLessThan(full.x1 - full.x0);
    expect(z.x0).toBeGreaterThanOrEqual(0);
  });

  it("pan keeps size and clamps", () => {
    const view = { x0: 10, y0: 10, x1: 50, y1: 50 };
    const panned = panView(view, 1000, 0, bounds);
    expect(panned.x1 - panned.x0).toBeCloseTo(40, 5);
    expect(panned.x1).toBeLessThanOrEqual(bounds.width);
  });

  it("normalize flips inverted drag", () => {
    const n = normalizeRect({ x0: 50, y0: 40, x1: 10, y1: 20 });
    expect(n.x0).toBe(10);
    expect(n.x1).toBe(50);
    expect(n.y0).toBe(20);
    expect(n.y1).toBe(40);
  });
});

function rectNearSquare(r: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const w = Math.abs(r.x1 - r.x0);
  const h = Math.abs(r.y1 - r.y0);
  return Math.abs(w - h) / Math.max(w, h) < 0.02;
}
