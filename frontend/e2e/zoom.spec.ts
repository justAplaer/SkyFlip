import { expect, test } from "@playwright/test";

function targetButton(page: import("@playwright/test").Page, name: RegExp) {
  return page.getByRole("group", { name: "Official test targets" }).getByRole("button", { name });
}

async function waitForBlink(page: import("@playwright/test").Page) {
  await expect(
    page.getByRole("region", { name: /blink player/i }).getByRole("button", { name: /^(Pause|Play)$/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("blink-canvas").waitFor({ state: "visible" });
}

test.describe("Phase 1 drag-to-zoom", () => {
  test("drag box zooms view; Back and Reset restore; no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/?target=barnards_star");
    await targetButton(page, /Barnard/i).click();
    await waitForBlink(page);

    await page.getByRole("button", { name: /^Select$/i }).click();
    const canvas = page.getByTestId("blink-canvas");
    await canvas.click(); // focus
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    const b = box!;

    // Dispatch PointerEvents on the canvas (more reliable than page.mouse for React)
    await canvas.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const fire = (type: string, fx: number, fy: number) => {
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: r.left + r.width * fx,
            clientY: r.top + r.height * fy,
          }),
        );
      };
      fire("pointerdown", 0.3, 0.3);
      fire("pointermove", 0.75, 0.75);
      fire("pointerup", 0.75, 0.75);
    });
    await page.waitForTimeout(350);

    const viewAfter = await canvas.getAttribute("data-view");
    expect(viewAfter).toBeTruthy();
    const v = JSON.parse(viewAfter!);
    expect(v.x1 - v.x0).toBeGreaterThan(2);
    expect(v.y1 - v.y0).toBeGreaterThan(2);
    // Zoomed-in: width clearly less than full Barnard's native (~96 px)
    expect(v.x1 - v.x0).toBeLessThan(70);

    // Zoom persists across frame step
    await page.getByRole("button", { name: /Step \+/i }).click();
    const viewStepped = JSON.parse((await canvas.getAttribute("data-view"))!);
    expect(viewStepped.x0).toBeCloseTo(v.x0, 1);
    expect(viewStepped.x1).toBeCloseTo(v.x1, 1);

    await page.getByRole("button", { name: /^Back$/i }).click();
    await page.waitForTimeout(280);
    const afterBack = JSON.parse((await canvas.getAttribute("data-view"))!);
    expect(afterBack.x0).toBeLessThanOrEqual(1);
    expect(afterBack.x1).toBeGreaterThan(afterBack.x0);

    await page.getByRole("button", { name: /^Reset$/i }).click();
    await page.waitForTimeout(280);
    const afterReset = JSON.parse((await canvas.getAttribute("data-view"))!);
    expect(afterReset.x0).toBeLessThanOrEqual(0.5);

    const real = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("while rendering a different component"),
    );
    expect(real).toEqual([]);
  });

  test("ghost still moves ~7 px/frame after zoom (stub track)", async ({ page }) => {
    await page.route("**/api/predicted-track*", async (route) => {
      const track = Array.from({ length: 5 }, (_, i) => ({
        epoch_id: `stub-e${i}`,
        mjd: 60000 + i,
        ra: 133.79,
        dec: -7.245,
        x_pix: 40 + i * 7,
        y_pix: 40,
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
        }),
      });
    });

    await page.goto("/?target=wise0855");
    await targetButton(page, /WISE\s*0855/i).click();
    await waitForBlink(page);
    const blink = page.getByRole("region", { name: /blink player/i });
    const playPause = blink.getByRole("button", { name: /^(Pause|Play)$/ });
    if ((await playPause.textContent())?.includes("Pause")) await playPause.click();

    const canvas = page.getByTestId("blink-canvas");
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    const b = box!;
    // Mild zoom so ghost stays on-canvas
    await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.85, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const centroids: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(120);
      const cx = await page.evaluate(() => {
        const c = document.querySelector("[data-testid=blink-canvas]") as HTMLCanvasElement;
        const ctx = c.getContext("2d");
        if (!ctx) return null;
        const { width, height } = c;
        const data = ctx.getImageData(0, 0, width, height).data;
        let sx = 0;
        let n = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            if (data[idx] > 200 && data[idx + 1] > 160 && data[idx + 1] < 220 && data[idx + 2] < 120) {
              sx += x;
              n++;
            }
          }
        }
        return n > 0 ? sx / n : null;
      });
      expect(cx, `ghost on frame ${i}`).not.toBeNull();
      centroids.push(cx as number);
      await blink.getByRole("button", { name: /Step \+/i }).click();
    }
    const deltas = centroids.slice(1).map((c, i) => c - centroids[i]);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    // After zoom, Δx in canvas px should still be clearly positive (scaled 7 native px)
    expect(mean).toBeGreaterThan(2);
  });

  test("URL round-trip restores zoom; keyboard Reset works", async ({ page }) => {
    await page.goto("/?target=barnards_star&zx0=5&zy0=5&zx1=18&zy1=18");
    await targetButton(page, /Barnard/i).click();
    await waitForBlink(page);
    const canvas = page.getByTestId("blink-canvas");
    await page.waitForTimeout(400);
    const v = JSON.parse((await canvas.getAttribute("data-view"))!);
    expect(v.x0).toBeGreaterThanOrEqual(4);
    expect(v.x1).toBeLessThanOrEqual(20);

    await canvas.focus();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(280);
    const reset = JSON.parse((await canvas.getAttribute("data-view"))!);
    expect(reset.x0).toBeLessThanOrEqual(0.5);
  });
});
