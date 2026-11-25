import { afterEach, describe, expect, it } from "vitest";
import { readUrlState, shareUrl, writeUrlState } from "./urlState";

describe("urlState", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("reads empty query as empty state", () => {
    window.history.replaceState({}, "", "/");
    const s = readUrlState();
    expect(s.ra).toBeUndefined();
    expect(s.dec).toBeUndefined();
    expect(s.embed).toBe(false);
    expect(s.demo).toBe(false);
  });

  it("round-trips ra/dec/fov/stretch/target/epoch/tab", () => {
    writeUrlState({
      ra: 133.79512917,
      dec: -7.24514722,
      fov: 0.15,
      stretch: "asinh",
      target: "wise0855",
      epoch: 2,
      tab: "blink",
      embed: true,
    });
    const s = readUrlState();
    expect(s.ra).toBeCloseTo(133.79512917, 8);
    expect(s.dec).toBeCloseTo(-7.24514722, 8);
    expect(s.fov).toBe(0.15);
    expect(s.stretch).toBe("asinh");
    expect(s.target).toBe("wise0855");
    expect(s.epoch).toBe(2);
    expect(s.tab).toBe("blink");
    expect(s.embed).toBe(true);
  });

  it("shareUrl includes ra/dec/fov/target and returns absolute URL", () => {
    const url = shareUrl({
      ra: 269.45,
      dec: 4.69,
      fov: 0.05,
      target: "barnards_star",
      stretch: "linear",
    });
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain("ra=269.45");
    expect(url).toContain("dec=4.69");
    expect(url).toContain("target=barnards_star");
    expect(url).toContain("stretch=linear");
  });

  it("clears falsy embed/demo from the query string", () => {
    writeUrlState({ embed: true, demo: true, target: "rw_aurigae" });
    writeUrlState({ embed: false, demo: false, target: "rw_aurigae" });
    const qs = window.location.search;
    expect(qs).not.toContain("embed=");
    expect(qs).not.toContain("demo=");
    expect(qs).toContain("target=rw_aurigae");
  });

  it("round-trips zoom rectangle zx0..zy1", () => {
    writeUrlState({
      target: "barnards_star",
      zx0: 5,
      zy0: 6,
      zx1: 20,
      zy1: 21,
    });
    const s = readUrlState();
    expect(s.zx0).toBe(5);
    expect(s.zy0).toBe(6);
    expect(s.zx1).toBe(20);
    expect(s.zy1).toBe(21);
  });

  it("persists expert mode and omits simple default", () => {
    writeUrlState({ mode: "expert", target: "wise0855" });
    expect(window.location.search).toContain("mode=expert");
    expect(readUrlState().mode).toBe("expert");
    writeUrlState({ mode: "simple", target: "wise0855" });
    expect(window.location.search).not.toContain("mode=");
    expect(readUrlState().mode).toBeUndefined();
  });

  it("persists target_crop view and omits full_frame default", () => {
    writeUrlState({ view: "target_crop", target: "wise0855" });
    expect(window.location.search).toContain("view=target_crop");
    expect(readUrlState().view).toBe("target_crop");
    writeUrlState({ view: "full_frame", target: "wise0855" });
    expect(window.location.search).not.toContain("view=");
    expect(readUrlState().view).toBeUndefined();
  });

  it("round-trips change slider params", () => {
    writeUrlState({
      target: "wise0855",
      cmin: 1.5,
      cmax: 9,
      cmetric: "combined",
      cref: "first_epoch",
      cap: 2,
      csort: "change",
      cra: 133.8,
      cdec: -7.25,
    });
    const s = readUrlState();
    expect(s.cmin).toBe(1.5);
    expect(s.cmax).toBe(9);
    expect(s.cmetric).toBe("combined");
    expect(s.cref).toBe("first_epoch");
    expect(s.cap).toBe(2);
    expect(s.csort).toBe("change");
    expect(s.cra).toBeCloseTo(133.8, 5);
    expect(s.cdec).toBeCloseTo(-7.25, 5);
  });
});
