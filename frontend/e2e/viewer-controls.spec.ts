/**
 * Full-frame toolbar + box-zoom controls.
 * Mocks /api/cutouts (full_frame) and /api/frame tile pyramid so CI needs no IRSA.
 */
import { expect, test, type Page } from "@playwright/test";

const CSS = 640;
const NAXIS = 512;
const TILE = 256;

function tanWcs() {
  const scale = 6.15 / 3600;
  return {
    NAXIS: 2,
    NAXIS1: NAXIS,
    NAXIS2: NAXIS,
    CRPIX1: NAXIS / 2 + 0.5,
    CRPIX2: NAXIS / 2 + 0.5,
    CRVAL1: 133.76,
    CRVAL2: -7.24,
    CDELT1: -scale,
    CDELT2: scale,
    CTYPE1: "RA---TAN",
    CTYPE2: "DEC--TAN",
  };
}

/** Spatially varying tile so zoom/pan changes sampled center pixels. */
function floatTile(
  ny: number,
  nx: number,
  opts: { level: number; ty: number; tx: number; obsBoost: number },
): Buffer {
  const buf = Buffer.alloc(ny * nx * 4);
  const factor = 1 << opts.level;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const ix = (opts.tx * TILE + x) * factor;
      const iy = (opts.ty * TILE + y) * factor;
      // Peak near detector center; obsBoost shifts brightness per epoch
      const dx = ix - NAXIS / 2;
      const dy = iy - NAXIS / 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      const v = opts.obsBoost + Math.max(0, 1.5 - r / 80);
      buf.writeFloatLE(v, (y * nx + x) * 4);
    }
  }
  return buf;
}

function flagsTile(ny: number, nx: number): Buffer {
  return Buffer.alloc(ny * nx * 4); // zeros int32
}

async function mockFullFrameApi(page: Page) {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  const frames = [0, 1, 2].map((i) => ({
    epoch_id: `obs${i}|SPHEREx-D5|6000${i}.0`,
    obs_id: `obs${i}`,
    mjd: 60000 + i,
    time_iso: `2025-01-0${i + 1}T00:00:00`,
    bandpass: "SPHEREx-D5",
    detector: 5,
    image_url: "",
    source_url: `https://example.test/obs${i}.fits`,
    array_shape: [NAXIS, NAXIS],
    target_x_pix: NAXIS / 2,
    target_y_pix: NAXIS / 2,
    subtract_zodi: false,
    view_mode: "full_frame",
    frame_meta_url: `/api/frame/obs${i}/5/meta`,
    wcs: tanWcs(),
    bunit: "MJy/sr",
    stretch_hint: { p01: 0, p50: 1, p995: 2 },
  }));

  await page.route("**/api/health**", async (route) => {
    await route.fulfill({
      json: { status: "ok", source: "live", services: {}, demo_cache_available: true },
    });
  });

  await page.route("**/api/cutouts**", async (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("view_mode") === "full_frame") {
      await route.fulfill({
        json: {
          ra: 133.76,
          dec: -7.24,
          fov_deg: 0.05,
          frames,
          source: "live",
          pixel_scale_arcsec: 6.15,
          subtract_zodi: false,
          view_mode: "full_frame",
          note: "mocked full frame",
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        ra: 133.76,
        dec: -7.24,
        fov_deg: 0.05,
        frames: [],
        source: "live",
        pixel_scale_arcsec: 6.15,
        view_mode: "target_crop",
      },
    });
  });

  await page.route("**/api/frame/*/*/meta**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const obs = path.split("/")[3] ?? "obs0";
    await route.fulfill({
      json: {
        obs_id: obs,
        detector: 5,
        shape: [NAXIS, NAXIS],
        naxis1: NAXIS,
        naxis2: NAXIS,
        tile_size: TILE,
        n_levels: 2,
        subtract_zodi: false,
        bunit: "MJy/sr",
        source_url: `https://example.test/${obs}.fits`,
        mjd: 60000,
        time_iso: "2025-01-01T00:00:00",
        bandpass: "SPHEREx-D5",
        wcs: tanWcs(),
        stats: { p01: 0.1, p50: 1.0, p995: 1.9, z1: 0.1, z2: 1.9 },
        units: "MJy/sr",
        target_x_pix: NAXIS / 2,
        target_y_pix: NAXIS / 2,
      },
    });
  });

  await page.route("**/api/frame/*/*/tile/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    // /api/frame/{obs}/{det}/tile/{level}/{ty}/{tx}
    const level = Number(parts[6] ?? 0);
    const factor = 1 << level;
    const ly = Math.ceil(NAXIS / factor);
    const lx = Math.ceil(NAXIS / factor);
    const ty = Number(parts[7] ?? 0);
    const tx = Number(parts[8] ?? 0);
    const ny = Math.min(TILE, ly - ty * TILE);
    const nx = Math.min(TILE, lx - tx * TILE);
    // Vary value by obs id so epoch steps change pixels
    const obs = parts[3] ?? "obs0";
    const boost = obs === "obs0" ? 0.2 : obs === "obs1" ? 0.8 : 1.4;
    await route.fulfill({
      contentType: "application/octet-stream",
      body: floatTile(Math.max(1, ny), Math.max(1, nx), {
        level,
        ty,
        tx,
        obsBoost: boost,
      }),
    });
  });

  await page.route("**/api/frame/*/*/flags/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const level = Number(parts[6] ?? 0);
    const factor = 1 << level;
    const ly = Math.ceil(NAXIS / factor);
    const lx = Math.ceil(NAXIS / factor);
    const ty = Number(parts[7] ?? 0);
    const tx = Number(parts[8] ?? 0);
    const ny = Math.min(TILE, ly - ty * TILE);
    const nx = Math.min(TILE, lx - tx * TILE);
    await route.fulfill({
      contentType: "application/octet-stream",
      body: flagsTile(Math.max(1, ny), Math.max(1, nx)),
    });
  });

  await page.route("**/api/predicted-track**", async (route) => {
    await route.fulfill({
      json: {
        name: "WISE 0855",
        ra: 133.76,
        dec: -7.24,
        points: [],
        source: "live",
        method: "mock",
        pixel_scale_arcsec: 6.15,
        historical_markers: [],
        missing_markers: [],
      },
    });
  });

  await page.route("**/api/change-scores**", async (route) => {
    await route.fulfill({
      json: {
        ra: 133.76,
        dec: -7.24,
        radius_pix: 1.5,
        metric: "brightness_snr",
        reference: "median_others",
        frames: [],
        motion: {},
        source: "live",
        pixel_scale_arcsec: 6.15,
      },
    });
  });

  return consoleErrors;
}

async function sampleCanvas(page: Page): Promise<number[]> {
  return page.locator('[data-testid="ff-canvas"]').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext("2d");
    if (!ctx) return [];
    // Sample near CSS-pixel center (canvas may be DPR-scaled).
    const x = Math.floor(c.width / 2);
    const y = Math.floor(c.height / 2);
    const { data } = ctx.getImageData(x, y, 8, 8);
    const out: number[] = [];
    for (let i = 0; i < data.length; i += 16) out.push(data[i]!);
    return out;
  });
}

function zoomValue(page: Page) {
  return page.getByRole("textbox", { name: "Zoom value" });
}

test.describe("full-frame viewer controls", () => {
  test("toolbar, box zoom, typed zoom; no console errors", async ({ page }) => {
    const errors = await mockFullFrameApi(page);
    await page.goto(
      "/?ra=133.76&dec=-7.24&fov=0.05&tab=viewer&target=wise0855&stretch=linear",
    );

    // Ensure Full frame mode
    await page.getByLabel("Full frame or target crop").selectOption("full_frame");
    await expect(page.getByTestId("ff-canvas")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("ff-status")).toContainText(/Epoch \d+ of 3/, {
      timeout: 15_000,
    });
    // Wait for metas; pause auto-play so toolbar assertions stay stable.
    await expect(page.getByTestId("ff-play")).toBeEnabled({ timeout: 15_000 });
    if ((await page.getByTestId("ff-play").getAttribute("aria-pressed")) === "true" ||
        (await page.getByTestId("ff-play").textContent()) === "Pause") {
      await page.getByTestId("ff-play").click();
    }
    await page.getByTestId("ff-step-prev").click(); // land on epoch 0 if mid-blink
    await page.getByTestId("ff-step-prev").click();
    await page.getByTestId("ff-step-prev").click();

    // Wait until tiles paint (non-black sample), then Fit so zoom-in is measurable.
    await expect
      .poll(async () => (await sampleCanvas(page)).some((v) => v > 0), { timeout: 15_000 })
      .toBeTruthy();
    await page.getByTestId("ff-fit").click();
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeCloseTo((CSS / NAXIS) * 0.95, 1);
    const beforeZoom = await sampleCanvas(page);
    const zoomBefore = Number(await zoomValue(page).inputValue());

    await page.getByTestId("ff-zoom-in").click();
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeGreaterThan(zoomBefore);
    // Zoom in around center of a peaked field → brighter/tighter sample
    await expect
      .poll(async () => {
        const s = await sampleCanvas(page);
        return s.some((v, i) => v !== beforeZoom[i]);
      }, { timeout: 10_000 })
      .toBeTruthy();

    const mid = Number(await zoomValue(page).inputValue());
    await page.getByTestId("ff-zoom-out").click();
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeLessThan(mid);

    await page.getByTestId("ff-fit").click();
    // 512² into 640 CSS → fit ≈ 0.95 * 640/512 ≈ 1.19
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeCloseTo((CSS / NAXIS) * 0.95, 1);

    await page.getByTestId("ff-one-to-one").click();
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeCloseTo(1, 1);

    await page.getByTestId("ff-goto-target").click();
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeGreaterThan(1.5);

    // Step +
    const status = page.getByTestId("ff-status");
    // Ensure index 0
    for (let i = 0; i < 3; i++) await page.getByTestId("ff-step-prev").click();
    await expect(status).toHaveAttribute("data-epoch-index", "0");
    await page.getByTestId("ff-step-next").click();
    await expect(status).toHaveAttribute("data-epoch-index", "1");

    // Play advances epoch
    await page.getByTestId("ff-play").click();
    await expect
      .poll(async () => status.getAttribute("data-epoch-index"), { timeout: 5_000 })
      .not.toBe("1");
    await page.getByTestId("ff-play").click(); // pause

    // Box zoom (start from fit so the scale change is obvious)
    await page.getByTestId("ff-fit").click();
    await page.getByTestId("ff-tool-box").click();
    await expect(page.getByTestId("ff-tool-box")).toHaveAttribute("aria-pressed", "true");
    const canvas = page.getByTestId("ff-canvas");
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeCloseTo((CSS / NAXIS) * 0.95, 1);
    const z0 = Number(await zoomValue(page).inputValue());
    await canvas.dragTo(canvas, {
      sourcePosition: { x: 160, y: 160 },
      targetPosition: { x: 420, y: 420 },
    });
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()), { timeout: 10_000 })
      .toBeGreaterThan(z0 + 0.5);

    // Typed zoom
    await zoomValue(page).fill("2.5");
    await zoomValue(page).press("Enter");
    await expect
      .poll(async () => Number(await zoomValue(page).inputValue()))
      .toBeCloseTo(2.5, 1);

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });
});
