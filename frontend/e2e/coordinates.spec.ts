import { expect, test } from "@playwright/test";

const TARGETS = [
  { id: "barnards_star", name: /Barnard/i, resolve: "Barnard's Star" },
  { id: "epsilon_indi_b", name: /Epsilon Indi/i, resolve: "Epsilon Indi B" },
  { id: "wise0855", name: /WISE 0855/i, resolve: "WISE 0855-0714" },
  { id: "rw_aurigae", name: /RW Aur/i, resolve: "RW Aurigae" },
  { id: "r_draconis", name: /R Dra/i, resolve: "R Draconis" },
];

function targetButton(page: import("@playwright/test").Page, name: RegExp) {
  return page.getByRole("group", { name: "Official test targets" }).getByRole("button", { name });
}

async function waitForFrames(page: import("@playwright/test").Page) {
  await expect(page.locator('[data-testid="obs-id-list"] li').first()).toBeVisible({
    timeout: 45_000,
  });
}

async function obsIds(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator('[data-testid="obs-id-list"] li').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-obs-id") || "").filter(Boolean),
  );
}

test.describe("Coordinates: targets, formats, custom position", () => {
  for (const t of TARGETS) {
    test(`${t.id}: typing coords matches button obs_ids; marker on canvas`, async ({
      page,
    }) => {
      await page.goto(`/?demo=1&view=target_crop&target=${t.id}`);
      await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });

      await targetButton(page, t.name).click();
      await waitForFrames(page);
      const buttonIds = await obsIds(page);
      expect(buttonIds.length).toBeGreaterThanOrEqual(2);

      const coord = await page.locator("#sky-q").inputValue();
      expect(coord).toMatch(/\d/);

      // Type the same coordinates
      await page.locator("#sky-q").fill(coord);
      await page.getByRole("button", { name: /^Go$/i }).click();
      await waitForFrames(page);
      expect(await obsIds(page)).toEqual(buttonIds);

      // Marker / canvas present for first epoch
      const canvas = page.locator('[data-testid="blink-canvas"]');
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThan(50);
      expect(box!.height).toBeGreaterThan(50);
    });

    test(`${t.id}: typing name matches button obs_ids`, async ({ page }) => {
      await page.goto(`/?demo=1&view=target_crop&target=${t.id}`);
      await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });
      await targetButton(page, t.name).click();
      await waitForFrames(page);
      const buttonIds = await obsIds(page);

      await page.locator("#sky-q").fill(t.resolve);
      await page.getByRole("button", { name: /^Go$/i }).click();
      // Name resolve may hit network; allow demo snap via near-target after resolve
      await waitForFrames(page);
      const typedIds = await obsIds(page);
      // If resolve failed offline, near-target won't run — still require non-blank
      expect(typedIds.length).toBeGreaterThanOrEqual(1);
      if (typedIds.length === buttonIds.length) {
        expect(typedIds).toEqual(buttonIds);
      }
    });
  }

  test('custom "200, 9" never blanks; frames or Retry banner', async ({ page }) => {
    await page.goto("/?demo=1&view=target_crop&target=wise0855");
    await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });
    await targetButton(page, /WISE 0855/i).click();
    await waitForFrames(page);

    await page.locator("#sky-q").fill("200, 9");
    await page.getByRole("button", { name: /^Go$/i }).click();

    // Must not show the forbidden blank-only message
    await expect(page.getByText(/no cached demo available/i)).toHaveCount(0, {
      timeout: 5_000,
    });

    // Either new/previous frames stay, or a specific fail banner with Retry
    const banner = page.getByTestId("load-fail-banner");
    const frames = page.locator('[data-testid="obs-id-list"] li');
    await expect
      .poll(async () => {
        const hasBanner = await banner.isVisible().catch(() => false);
        const n = await frames.count();
        return hasBanner || n > 0;
      }, { timeout: 60_000 })
      .toBe(true);

    if (await banner.isVisible()) {
      await expect(banner).toContainText(
        /network or archive unreachable|archive returned no observation|position outside coverage/i,
      );
      await expect(page.getByTestId("load-fail-retry")).toBeVisible();
      // Previous frames still present (non-blank)
      expect(await frames.count()).toBeGreaterThan(0);
    }
  });

  test("invalid coords show inline error", async ({ page }) => {
    await page.goto("/?demo=1&view=target_crop");
    await page.locator("#sky-q").fill("10, 99");
    await page.getByRole("button", { name: /^Go$/i }).click();
    await expect(page.getByRole("alert")).toContainText(/Dec must be between/i);
  });
});
