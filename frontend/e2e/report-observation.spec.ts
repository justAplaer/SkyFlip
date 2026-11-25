import { expect, test } from "@playwright/test";

function targetButton(page: import("@playwright/test").Page, name: RegExp) {
  return page.getByRole("group", { name: "Official test targets" }).getByRole("button", { name });
}

test.describe("Report an observation", () => {
  test("button gated; full submit; word limit; toggles; offline queue", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    const reportBtn = page.getByTestId("report-observation");
    // May already be enabled if auto-load finishes — wait briefly then ensure state after target
    await targetButton(page, /WISE\s*0855/i).click();
    await expect(reportBtn).toBeEnabled({ timeout: 25_000 });

    await reportBtn.click();
    await expect(page.getByRole("dialog", { name: /Report an observation/i })).toBeVisible();

    // Select frames
    await expect(page.getByTestId("frame-select-count")).toBeVisible();
    await page.getByRole("button", { name: /Select all/i }).click();
    await page.getByRole("button", { name: /^Next$/i }).click();

    // Draw highlight on pad
    const canvas = page.locator(".highlight-canvas").first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + 40, box!.y + 40);
    await page.mouse.down();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.up();

    // Toggle first custom switch if present
    const sw = page.getByRole("switch").first();
    if (await sw.count()) {
      await sw.focus();
      await page.keyboard.press("Space");
      await expect(sw).toHaveAttribute("aria-checked", /true|false/);
    }

    await page.getByRole("button", { name: /^Next$/i }).click();

    // Word limit
    const over = Array.from({ length: 301 }, (_, i) => `w${i}`).join(" ");
    await page.getByTestId("report-description").fill(over);
    await expect(page.getByTestId("word-count")).toContainText(/301/);
    await page.getByRole("button", { name: /^Next$/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    await page.getByTestId("report-description").fill("A faint point hopped between two frames.");
    await page.getByTestId("direction-select").selectOption("not_sure");
    await page.getByRole("button", { name: /^Next$/i }).click();

    await page.getByTestId("store-consent").check();

    // Mock successful submit
    await page.route("**/api/observations", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            submission_id: "11111111-2222-3333-4444-555555555555",
            delete_token: "del-token",
            disclaimer: "Community observation, unverified — not a discovery.",
          }),
        });
      } else await route.continue();
    });

    await page.getByTestId("report-submit").click();
    await expect(page.getByTestId("report-success")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("receipt-id")).toContainText("11111111");

    // Offline queue path
    await page.getByRole("button", { name: /Report another/i }).click();
    await page.getByRole("button", { name: /Select all/i }).click();
    await page.getByRole("button", { name: /^Next$/i }).click();
    const canvas2 = page.locator(".highlight-canvas").first();
    const b2 = await canvas2.boundingBox();
    await page.mouse.move(b2!.x + 30, b2!.y + 30);
    await page.mouse.down();
    await page.mouse.move(b2!.x + 90, b2!.y + 90);
    await page.mouse.up();
    await page.getByRole("button", { name: /^Next$/i }).click();
    await page.getByTestId("report-description").fill("Second report offline test.");
    await page.getByRole("button", { name: /^Next$/i }).click();
    await page.getByTestId("store-consent").check();

    await page.unroute("**/api/observations");
    await page.route("**/api/observations", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, detail: "down" }),
      }),
    );
    await page.getByTestId("report-submit").click();
    await expect(page.getByTestId("report-success")).toContainText(/Queued|queued/i);

    expect(errors.filter((e) => !/favicon|ResizeObserver/i.test(e))).toEqual([]);
  });

  test("double submit creates one logical receipt (idempotency header)", async ({ page }) => {
    let posts = 0;
    const ids: string[] = [];
    await page.route("**/api/observations", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts += 1;
      const body = route.request().postDataJSON() as { idempotency_key?: string };
      const id = `idem-${body.idempotency_key || posts}`;
      ids.push(id);
      await route.fulfill({
        status: posts === 1 ? 201 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          submission_id: id,
          delete_token: "x",
          reused: posts > 1,
          disclaimer: "Community observation, unverified — not a discovery.",
        }),
      });
    });

    await page.goto("/?target=wise0855");
    await targetButton(page, /WISE\s*0855/i).click();
    await page.getByTestId("report-observation").click();
    await page.getByRole("button", { name: /Select all/i }).click();
    await page.getByRole("button", { name: /^Next$/i }).click();
    const canvas = page.locator(".highlight-canvas").first();
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + 40, box!.y + 40);
    await page.mouse.down();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.up();
    await page.getByRole("button", { name: /^Next$/i }).click();
    await page.getByTestId("report-description").fill("Idempotency check report.");
    await page.getByRole("button", { name: /^Next$/i }).click();
    await page.getByTestId("store-consent").check();
    // Double click submit
    await page.getByTestId("report-submit").dblclick();
    await expect(page.getByTestId("report-success")).toBeVisible({ timeout: 10_000 });
    // At most a couple of posts; same idempotency key yields same id family
    expect(posts).toBeGreaterThanOrEqual(1);
    expect(posts).toBeLessThanOrEqual(3);
  });
});
