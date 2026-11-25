import { expect, test } from "@playwright/test";

const LIVE_RA = 15.5;
const LIVE_DEC = -12.25;

const stubChangeScores = {
  ra: LIVE_RA,
  dec: LIVE_DEC,
  radius_pix: 1.5,
  metric: "brightness_snr",
  reference: "median_others",
  frames: [
    {
      epoch_id: "live-stub-0",
      mjd: 60000,
      obs_date: "2025-01-01",
      wavelength_um: 0.9,
      score: 4.2,
      score_err: 0.5,
      score_unit: "dimensionless (S/N)",
      status: "ok",
      status_reason: null,
      n_masked: 0,
      n_aperture_pixels: 7,
      wavelength_mismatched: false,
      wavelength_diff_um: 0,
    },
    {
      epoch_id: "live-stub-1",
      mjd: 60010,
      obs_date: "2025-01-11",
      wavelength_um: 0.91,
      score: 1.1,
      score_err: 0.4,
      score_unit: "dimensionless (S/N)",
      status: "ok",
      status_reason: null,
      n_masked: 0,
      n_aperture_pixels: 7,
      wavelength_mismatched: false,
      wavelength_diff_um: 0.01,
    },
  ],
  motion: null,
  source: "live",
  pixel_scale_arcsec: 6.15,
  aperture_x_pix: 14,
  aperture_y_pix: 14,
  is_synthetic: false,
  banner: null,
};

test.describe("Bug 6: live=1 for non-preset change scores", () => {
  test("free-text coordinates request live=1 and show stubbed scores", async ({ page }) => {
    let sawLive = false;

    await page.route("**/api/cutouts*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ra: LIVE_RA,
          dec: LIVE_DEC,
          fov_deg: 0.2,
          pixel_scale_arcsec: 6.15,
          source: "live",
          banner: null,
          frames: [
            {
              epoch_id: "live-stub-0",
              mjd: 60000,
              obs_date: "2025-01-01",
              wavelength_um: 0.9,
              detector: 1,
              image_url: "/demo-data/wise0855/frame_000.npy",
              flags_url: "/demo-data/wise0855/frame_000_flags.npy",
              naxis1: 29,
              naxis2: 29,
            },
            {
              epoch_id: "live-stub-1",
              mjd: 60010,
              obs_date: "2025-01-11",
              wavelength_um: 0.91,
              detector: 1,
              image_url: "/demo-data/wise0855/frame_001.npy",
              flags_url: "/demo-data/wise0855/frame_001_flags.npy",
              naxis1: 29,
              naxis2: 29,
            },
          ],
        }),
      });
    });

    await page.route("**/api/change-scores*", async (route) => {
      const url = route.request().url();
      if (url.includes("live=1")) sawLive = true;
      expect(url).toContain("live=1");
      expect(url).not.toMatch(/[?&]target=/);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(stubChangeScores),
      });
    });

    await page.route("**/api/predicted-track**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          name: "free-text",
          ra: LIVE_RA,
          dec: LIVE_DEC,
          source: "live",
          method: "stub",
          pixel_scale_arcsec: 6.15,
          points: [],
        }),
      });
    });

    // Empty target= so App does not default to the WISE 0855 preset.
    await page.goto(`/?ra=${LIVE_RA}&dec=${LIVE_DEC}&target=`);
    await page.getByLabel(/Coordinates or name/i).fill(`${LIVE_RA}, ${LIVE_DEC}`);
    await page.getByRole("button", { name: /^Go$/i }).click();

    await expect(page.getByTestId("change-slider")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => {
        const t = await page.getByTestId("change-count").innerText();
        const m = /showing (\d+) of (\d+)/.exec(t);
        return m ? Number(m[2]) : 0;
      }, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    expect(sawLive).toBe(true);
    await expect(page.getByTestId("change-error")).toHaveCount(0);
  });

  test("live change-scores failure shows not computed with retry", async ({ page }) => {
    await page.route("**/api/cutouts*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ra: LIVE_RA,
          dec: LIVE_DEC,
          fov_deg: 0.2,
          pixel_scale_arcsec: 6.15,
          source: "live",
          banner: null,
          frames: [
            {
              epoch_id: "live-stub-0",
              mjd: 60000,
              obs_date: "2025-01-01",
              wavelength_um: 0.9,
              detector: 1,
              image_url: "/demo-data/wise0855/frame_000.npy",
              flags_url: null,
              naxis1: 29,
              naxis2: 29,
            },
            {
              epoch_id: "live-stub-1",
              mjd: 60010,
              obs_date: "2025-01-11",
              wavelength_um: 0.91,
              detector: 1,
              image_url: "/demo-data/wise0855/frame_001.npy",
              flags_url: null,
              naxis1: 29,
              naxis2: 29,
            },
          ],
        }),
      });
    });

    await page.route("**/api/change-scores*", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { message: "live change scores failed", source: "error" },
        }),
      });
    });

    await page.route("**/api/predicted-track**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          name: "free-text",
          ra: LIVE_RA,
          dec: LIVE_DEC,
          source: "live",
          method: "stub",
          pixel_scale_arcsec: 6.15,
          points: [],
        }),
      });
    });

    await page.goto(`/?ra=${LIVE_RA}&dec=${LIVE_DEC}&target=`);
    await page.getByLabel(/Coordinates or name/i).fill(`${LIVE_RA}, ${LIVE_DEC}`);
    await page.getByRole("button", { name: /^Go$/i }).click();

    await expect(page.getByTestId("change-error")).toContainText(/not computed/i, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("change-retry")).toBeVisible();
    // Slider stays visible — never a blank panel with no reason
    await expect(page.getByTestId("change-slider")).toBeVisible();
  });
});
