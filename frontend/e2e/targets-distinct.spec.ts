/**
 * Each of the 5 preset targets must show a distinct obs_id list, and Play
 * must advance epochs. Uses real demo packs from /demo-data (target_crop).
 */
import { expect, test, type Page } from "@playwright/test";

const TARGETS = [
  "barnards_star",
  "epsilon_indi_b",
  "wise0855",
  "rw_aurigae",
  "r_draconis",
] as const;

async function waitForObsList(page: Page) {
  await expect(page.getByTestId("obs-id-list")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => page.locator("[data-testid=obs-id-list] [data-obs-id]").count(), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(5);
}

async function readObsIds(page: Page): Promise<string[]> {
  return page.locator("[data-testid=obs-id-list] [data-obs-id]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-obs-id") || "").filter(Boolean),
  );
}

async function clickTarget(page: Page, id: string) {
  await page.getByTestId(`target-${id}`).click();
  await waitForObsList(page);
}

test.describe("distinct targets + blink", () => {
  test("five targets have different obs_id lists; play and speed work", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    // Fail live cutouts quickly so each preset falls back to its restored demo pack.
    await page.route("**/api/cutouts*", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "e2e: force demo fallback" }),
      });
    });

    await page.goto("/?tab=viewer");
    const viewSelect = page.getByLabel("Full frame or target crop");
    if (await viewSelect.count()) {
      await viewSelect.selectOption("target_crop");
    }

    const lists: Record<string, string[]> = {};
    for (const id of TARGETS) {
      await clickTarget(page, id);
      const obs = await readObsIds(page);
      expect(obs.length, `${id} epoch count`).toBeGreaterThanOrEqual(5);
      lists[id] = obs;

      // Target circle / predicted pixel must be reported for current epoch.
      const status = page.getByTestId("blink-status");
      await expect(status).toBeVisible();
      const obsId = await status.getAttribute("data-obs-id");
      expect(obsId).toBeTruthy();
      expect(obs).toContain(obsId!);
    }

    for (let i = 0; i < TARGETS.length; i++) {
      for (let j = i + 1; j < TARGETS.length; j++) {
        const a = TARGETS[i]!;
        const b = TARGETS[j]!;
        expect(lists[a], `${a} vs ${b}`).not.toEqual(lists[b]);
        const overlap = lists[a]!.filter((x) => lists[b]!.includes(x));
        expect(overlap, `${a}∩${b}`).toEqual([]);
      }
    }

    // Blink on WISE 0855: Play advances epoch; speed 3 Hz is faster than 1 Hz.
    await clickTarget(page, "wise0855");
    const status = page.getByTestId("blink-status");
    const play = page.getByTestId("blink-play");
    await expect(play).toBeEnabled({ timeout: 60_000 });

    // Pause if auto-playing, then measure at 1 Hz then 3 Hz.
    await expect(play).toBeEnabled({ timeout: 60_000 });
    if ((await play.getAttribute("aria-pressed")) === "true") {
      await play.click();
    }
    const speedBox = page.getByLabel("Blink speed value");
    await speedBox.fill("1");
    await speedBox.press("Enter");
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    const i0 = Number(await status.getAttribute("data-epoch-index"));
    await expect
      .poll(async () => Number(await status.getAttribute("data-epoch-index")), {
        timeout: 5_000,
      })
      .not.toBe(i0);

    // Sample canvas mid-pixel before/after step to ensure content changes.
    const canvas = page.getByTestId("blink-canvas");
    const sample = async () =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext("2d")!;
        const { data } = ctx.getImageData((c.width / 2) | 0, (c.height / 2) | 0, 1, 1);
        return `${data[0]},${data[1]},${data[2]}`;
      });
    const pixA = await sample();
    await page.getByTestId("blink-step-next").click();
    await page.waitForTimeout(50);
    const pixB = await sample();
    // Different epochs should usually differ; allow rare identical mid-pixel.
    const iA = Number(await status.getAttribute("data-epoch-index"));
    await page.getByTestId("blink-step-next").click();
    await page.waitForTimeout(50);
    const iB = Number(await status.getAttribute("data-epoch-index"));
    expect(iB).not.toBe(iA);
    if (pixA === pixB) {
      // One more step — at least one of three samples must differ for a real blink.
      await page.getByTestId("blink-step-next").click();
      await page.waitForTimeout(50);
      const pixC = await sample();
      expect([pixA, pixB]).not.toContain(pixC);
    }

    // Speed 3 Hz: more advances in ~1s than a single 1 Hz tick.
    if ((await play.getAttribute("aria-pressed")) === "true") await play.click();
    await speedBox.fill("3");
    await speedBox.press("Enter");
    const before = Number(await status.getAttribute("data-epoch-index"));
    const nFrames = Number(await status.getAttribute("data-epoch-count"));
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(1100);
    const after = Number(await status.getAttribute("data-epoch-index"));
    const advanced = (after - before + nFrames) % nFrames;
    expect(advanced).toBeGreaterThanOrEqual(2);

    expect(
      consoleErrors.filter(
        (e) =>
          !/favicon/i.test(e) &&
          !/Cannot update a component/i.test(e) &&
          !/Download the React DevTools/i.test(e) &&
          !/503/i.test(e) &&
          !/Failed to load resource/i.test(e),
      ),
    ).toEqual([]);
  });
});
