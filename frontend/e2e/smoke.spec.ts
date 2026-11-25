import { expect, test } from "@playwright/test";

test("app shell loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").or(page.locator("h1")).first()).toBeVisible({
    timeout: 15_000,
  });
  // No uncaught white-screen: root should have content
  const rootText = await page.locator("#root").innerText();
  expect(rootText.length).toBeGreaterThan(10);
});

test("demo-data index is reachable as static asset", async ({ page }) => {
  const res = await page.request.get("/demo-data/index.json");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(Array.isArray(body.targets)).toBeTruthy();
  expect(body.targets.length).toBeGreaterThanOrEqual(5);
});
