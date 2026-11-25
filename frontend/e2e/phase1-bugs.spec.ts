import { expect, test } from "@playwright/test";

function targetButton(page: import("@playwright/test").Page, name: RegExp) {
  return page.getByRole("group", { name: "Official test targets" }).getByRole("button", { name });
}

test.describe("Phase 1 critical bugs", () => {
  test("switching from last frame of a long set to a shorter set does not white-screen", async ({
    page,
  }) => {
    await page.goto("/?target=barnards_star");
    await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });

    await targetButton(page, /Barnard/i).click();

    const stepPlus = page.getByRole("button", { name: /Step \+/i });
    await expect(stepPlus).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < 8; i++) {
      await stepPlus.click();
    }

    await targetButton(page, /WISE\s*0855/i).click();
    await expect(page.locator("#root")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/Cannot read properties of undefined/i);
    await expect(
      page.getByRole("region", { name: /blink player/i }).getByRole("button", { name: /^(Pause|Play)$/ }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("ghost marker centroid moves ~7 px per frame when predicted-track is stubbed", async ({
    page,
  }) => {
    await page.route("**/api/predicted-track*", async (route) => {
      const track = Array.from({ length: 5 }, (_, i) => ({
        epoch_id: `stub-e${i}`,
        mjd: 60000 + i,
        ra: 133.79 + i * 0.001,
        dec: -7.245,
        x_pix: 40 + i * 7,
        y_pix: 40,
        note: "stub",
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          name: "WISE 0855",
          ra: 133.79,
          dec: -7.245,
          points: track,
          source: "live",
          method: "stub",
          pixel_scale_arcsec: 6.15,
        }),
      });
    });

    await page.route("**/api/cutouts*", async (route) => {
      const frames = Array.from({ length: 5 }, (_, i) => ({
        epoch_id: `stub-e${i}`,
        obs_id: `stub${i}`,
        mjd: 60000 + i,
        time_iso: `2025-01-0${i + 1}T00:00:00`,
        bandpass: "SPHEREx-D1",
        detector: 1,
        image_url: "/demo-data/wise0855/frame_00_60801.10660.png",
        image_shape: [117, 117],
        float_shape: [117, 117],
        is_synthetic: true,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ra: 133.79,
          dec: -7.245,
          fov_deg: 0.15,
          frames,
          source: "live",
          pixel_scale_arcsec: 6.15,
          note: "stubbed for ghost motion test",
        }),
      });
    });

    await page.goto("/?target=wise0855");
    await targetButton(page, /WISE\s*0855/i).click();
    const blink = page.getByRole("region", { name: /blink player/i });
    const playPause = blink.getByRole("button", { name: /^(Pause|Play)$/ });
    await expect(playPause).toBeVisible({ timeout: 20_000 });
    if ((await playPause.textContent())?.includes("Pause")) {
      await playPause.click();
    }

    // Ensure ghost checkbox on
    const ghost = page.getByRole("checkbox", { name: /Ghost track/i });
    if (!(await ghost.isChecked())) await ghost.check();

    const centroids: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(200);
      const cx = await page.evaluate(() => {
        const canvas = document.querySelector(
          "[data-testid=blink-canvas]",
        ) as HTMLCanvasElement | null;
        if (!canvas) return null;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const { width, height } = canvas;
        const data = ctx.getImageData(0, 0, width, height).data;
        let sx = 0;
        let n = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            if (r > 200 && g > 160 && g < 220 && b < 120) {
              sx += x;
              n += 1;
            }
          }
        }
        return n > 0 ? sx / n : null;
      });
      expect(cx, `ghost centroid on frame ${i}`).not.toBeNull();
      centroids.push(cx as number);
      await page.getByRole("button", { name: /Step \+/i }).click();
    }

    const deltas = centroids.slice(1).map((c, i) => c - centroids[i]);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    expect(mean).toBeGreaterThan(3);
  });
});
