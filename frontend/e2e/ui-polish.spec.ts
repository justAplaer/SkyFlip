import { expect, test } from "@playwright/test";

async function dismissTourIfAny(page: import("@playwright/test").Page) {
  const tour = page.getByTestId("first-run-tour");
  if (await tour.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /^Skip$/i }).click();
  }
}

test.describe("UI polish: tabs, data panel, tour, embed share", () => {
  test("Validation and About tabs; Data pills; Help", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/?demo=1&view=target_crop&target=wise0855&mode=simple&tour=0");
    await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });
    await dismissTourIfAny(page);

    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Viewer" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Validation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "About" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Discovery/ })).toHaveCount(0);

    await page.getByRole("button", { name: /WISE 0855/i }).click();
    await expect(page.getByTestId("what-am-i-looking-at")).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('[data-testid="obs-id-list"] li').first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator(".data-panel .status-pills .pill").first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Validation" }).click();
    await expect(page.getByRole("heading", { name: "Validation" })).toBeVisible();

    await page.getByRole("button", { name: "About" }).click();
    await expect(
      page.getByRole("region", { name: "About SkyFlip" }).getByRole("note"),
    ).toContainText(/does not claim to discover Planet X/i);

    await page.getByRole("button", { name: "Viewer" }).click();
    await page.getByTestId("help-tour").click();
    await expect(page.getByTestId("help-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
  });

  test("labs=1 shows Discovery; Share has embed + cite", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/?demo=1&labs=1&mode=expert&tour=0");
    await expect(page.getByRole("button", { name: /Discovery/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator("summary", { hasText: "Share" }).click();
    await expect(page.getByTestId("copy-embed-code")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("cite-this-view")).toBeVisible();
  });

  test("Simple mode shows caption; Expert has FOV presets", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(
      "/?demo=1&view=target_crop&target=barnards_star&mode=simple&tour=0",
    );
    await dismissTourIfAny(page);
    await page.getByRole("button", { name: /Barnard/i }).click();
    await expect(page.getByTestId("what-am-i-looking-at")).toContainText(/Barnard/i, {
      timeout: 45_000,
    });
    await page.getByRole("button", { name: "Expert" }).click();
    await page.locator("summary", { hasText: "View" }).click();
    await expect(page.getByRole("group", { name: "FOV presets" })).toBeVisible();
  });
});
