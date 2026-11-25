import { expect, test } from "@playwright/test";

function targetButton(page: import("@playwright/test").Page, name: RegExp) {
  return page.getByRole("group", { name: "Official test targets" }).getByRole("button", { name });
}

test.describe("Phase 3 offline demo", () => {
  test("five targets + scoreboard work with API down", async ({ page }) => {
    // Block all backend API calls — static demo-data must carry the demo
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "offline", source: "error" }),
      }),
    );

    await page.goto("/");
    const names = [/Barnard/i, /Epsilon Indi/i, /WISE\s*0855/i, /RW Aurigae/i, /R Draconis/i];
    for (const name of names) {
      await targetButton(page, name).click();
      await expect(
        page.getByRole("region", { name: /blink player/i }).getByRole("button", { name: /^(Pause|Play)$/ }),
      ).toBeVisible({ timeout: 25_000 });
    }

    await page.getByRole("button", { name: "Scoreboard" }).click();
    await expect(page.getByRole("region", { name: /scoreboard/i })).toBeVisible({
      timeout: 15_000,
    });
    // Either live or cached-demo text
    await expect(page.locator("body")).toContainText(/scoreboard|recovered|not computed|cached/i);
  });
});
