import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChangeScoresQuery,
  clearChangeScoreCache,
  loadChangeScores,
} from "./changeScoreClient";

afterEach(() => {
  clearChangeScoreCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Bug 6: live=1 for non-preset change scores", () => {
  it("sends live=1 when there is no preset target", () => {
    const { url, live, timeoutMs } = buildChangeScoresQuery({
      ra: 10,
      dec: 20,
      radius: 1.5,
      metric: "brightness_snr",
      reference: "median_others",
    });
    expect(live).toBe(true);
    expect(url).toContain("live=1");
    expect(url).not.toContain("target=");
    expect(timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("does not send live=1 for a known preset target", () => {
    const { url, live, timeoutMs } = buildChangeScoresQuery({
      ra: 133.795,
      dec: -7.245,
      radius: 1.5,
      metric: "brightness_snr",
      reference: "median_others",
      target: "wise0855",
    });
    expect(live).toBe(false);
    expect(url).not.toContain("live=1");
    expect(url).toContain("target=wise0855");
    expect(timeoutMs).toBeLessThan(30_000);
  });

  it("treats blank target as non-preset", () => {
    const { live, url } = buildChangeScoresQuery({
      ra: 1,
      dec: 2,
      radius: 1.5,
      metric: "combined",
      reference: "first_epoch",
      target: "   ",
    });
    expect(live).toBe(true);
    expect(url).toContain("live=1");
  });

  it("surfaces a clear not-computed error when live archive returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ detail: { message: "live failed" } }),
      })),
    );
    await expect(
      loadChangeScores({
        ra: 10,
        dec: 20,
        radius: 1.5,
        metric: "brightness_snr",
        reference: "median_others",
      }),
    ).rejects.toThrow(/not computed: live change scores unavailable/i);
  });

  it("surfaces timed-out / cancelled state when the live request aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch should not be called after abort");
      }),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      loadChangeScores({
        ra: 11,
        dec: 22,
        radius: 1.5,
        metric: "brightness_snr",
        reference: "median_others",
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/not computed: (cancelled|timed out)/i);
  });
});
