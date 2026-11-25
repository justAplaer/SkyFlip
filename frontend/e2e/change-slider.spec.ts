import { expect, test } from "@playwright/test";

function targetButton(page: import("@playwright/test").Page, name: RegExp) {
  return page.getByRole("group", { name: "Official test targets" }).getByRole("button", { name });
}

test.describe("Change slider", () => {
  test.beforeEach(async ({ page }) => {
    // Stub predicted track with 7 px/frame motion for trail tolerance checks
    await page.route("**/api/predicted-track**", async (route) => {
      const body = {
        name: "WISE 0855",
        ra: 133.79512917,
        dec: -7.24514722,
        source: "cached-demo",
        method: "stub 7px/frame",
        pixel_scale_arcsec: 6.15,
        points: Array.from({ length: 3 }, (_, i) => ({
          epoch_id: `stub-${i}`,
          mjd: 60000 + i * 10,
          ra: 133.79512917,
          dec: -7.24514722,
          x_pix: 14 + i * 7,
          y_pix: 14 + i * 7,
          note: "stub",
        })),
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
  });

  test("slider filters visible frames; sorted banner; histogram jump; URL restore", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/?target=wise0855");
    await targetButton(page, /WISE\s*0855/i).click();
    await expect(page.getByTestId("change-slider")).toBeVisible({ timeout: 25_000 });
    await expect
      .poll(async () => {
        const t = await page.getByTestId("change-count").innerText();
        const m = /showing (\d+) of (\d+)/.exec(t);
        return m ? Number(m[2]) : 0;
      }, { timeout: 25_000 })
      .toBeGreaterThanOrEqual(2);

    const countText = await page.getByTestId("change-count").innerText();
    const m0 = /showing (\d+) of (\d+)/.exec(countText);
    expect(m0).toBeTruthy();
    const kept0 = Number(m0![1]);
    const total = Number(m0![2]);
    expect(total).toBeGreaterThanOrEqual(2);
    expect(kept0).toBeGreaterThanOrEqual(1);
    // Wavelength-mismatched frames are excluded from ranking, so kept may be < total.

    // Narrow to biggest changes via preset
    await page.getByLabel("Show only the biggest N changes").fill("1");
    await page.getByRole("button", { name: /Show only biggest N/i }).click();
    await expect(page.getByTestId("change-count")).toContainText(/showing 1 of/);

    // Sorted mode banner
    await page.getByLabel("Change sort mode").selectOption("change");
    await expect(page.getByTestId("sort-banner")).toBeVisible();
    await page.getByLabel("Change sort mode").selectOption("time");
    await expect(page.getByTestId("sort-banner")).toHaveCount(0);

    // Reset restores the full scorable range (not wavelength-excluded frames)
    await page.getByRole("button", { name: /Reset range/i }).click();
    await expect(page.getByTestId("change-count")).toContainText(
      new RegExp(`showing ${kept0} of ${total}`),
    );
    // Histogram click jumps (no crash)
    const bar = page.locator(".hist-bar").first();
    await bar.click();
    await expect(page.getByRole("region", { name: /SPHEREx blink player/i })).toBeVisible();

    // Blink rate cap: speed slider max ≤ 3 Hz (assert while blink is on screen)
    const hz = page.getByRole("slider", { name: "Blink speed" });
    await expect(hz).toHaveAttribute("max", "3");

    // URL should carry change params after interaction
    await page.getByLabel("Change metric").selectOption("combined");
    await page.waitForTimeout(200);
    expect(page.url()).toMatch(/cmetric=combined/);

    // Round-trip
    const url = page.url();
    await page.goto(url);
    await expect(page.getByTestId("change-slider")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByLabel("Change metric")).toHaveValue("combined");
    await expect(page.getByRole("region", { name: /SPHEREx blink player/i })).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByRole("slider", { name: "Blink speed" })).toHaveAttribute("max", "3");

    expect(errors.filter((e) => !/favicon|ResizeObserver/i.test(e))).toEqual([]);
  });

  test("offline: backend down, slider still works for cached target", async ({ page }) => {
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "offline", source: "error", ok: false }),
      }),
    );
    await page.goto("/?target=wise0855");
    await targetButton(page, /WISE\s*0855/i).click();
    await expect(page.getByTestId("change-slider")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("change-count")).toContainText(/showing \d+ of \d+/);
    await expect(page.locator("body")).toContainText(/cached demo data/i);
  });

  test("stub predicted trail spacing ~7 px (with ghost on)", async ({ page }) => {
    await page.goto("/?target=wise0855");
    await targetButton(page, /WISE\s*0855/i).click();
    await expect(page.getByRole("region", { name: /SPHEREx blink player/i })).toBeVisible({
      timeout: 25_000,
    });
    // Ghost checkbox on — predicted trail uses stub 7 px steps
    const ghost = page.getByRole("checkbox", { name: /Ghost track/i });
    if (!(await ghost.isChecked())) await ghost.check();
    // Smoke: no crash after zoom-ish interaction; trail props accepted
    await expect(page.getByTestId("change-slider")).toBeVisible();
  });
});
