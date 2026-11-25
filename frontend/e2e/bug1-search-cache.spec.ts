import { expect, test } from "@playwright/test";

function targetButton(page: import("@playwright/test").Page, name: RegExp) {
  return page.getByRole("group", { name: "Official test targets" }).getByRole("button", { name });
}

test.describe("Bug 1: free-text search keeps prior frames + specific banner", () => {
  test("Barnard's then free-text with archive down → keep frames + Retry banner", async ({
    page,
  }) => {
    await page.goto("/?demo=1&target=barnards_star&view=target_crop");
    await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });

    await targetButton(page, /Barnard/i).click();
    await expect(
      page.getByRole("region", { name: /blink player/i }).getByRole("button", { name: /^(Pause|Play)$/ }),
    ).toBeVisible({ timeout: 30_000 });

    await page.route("**/api/cutouts*", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          detail: {
            message: "network or archive unreachable",
            reason: "network_unreachable",
            source: "error",
          },
        }),
      });
    });

    await page.getByLabel(/Coordinates or name/i).fill("10.0, 20.0");
    await page.getByRole("button", { name: /^Go$/i }).click();

    // Specific banner + Retry — never blank the viewer
    await expect(page.getByTestId("load-fail-banner")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("load-fail-banner")).toContainText(
      /network or archive unreachable|archive returned no observation|position outside coverage/i,
    );
    await expect(page.getByTestId("load-fail-retry")).toBeVisible();
    await expect(page.getByText(/no cached demo available/i)).toHaveCount(0);

    // Previous blink frames stay on screen
    await expect(page.getByRole("region", { name: /blink player/i })).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: /^Using cached demo data/ }),
    ).toHaveCount(0);
  });
});
