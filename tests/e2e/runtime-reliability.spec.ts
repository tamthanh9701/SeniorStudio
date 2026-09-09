import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const target = process.env.STAGING_APP_URL;
  if (!target || !target.startsWith("https://")) test.skip(true, "RUN_ONLINE_E2E requires an approved HTTPS STAGING_APP_URL");
  if (process.env.RUN_ONLINE_E2E !== "1") test.skip(true, "ordinary e2e is skipped: RUN_ONLINE_E2E is not enabled");
  await page.goto(target!);
});

test("staging app responds without exposing credentials", async ({ page }) => {
  await expect(page).toHaveTitle(/SeniorStudio/i);
  await expect(page.locator("body")).not.toContainText(/sk-[A-Za-z0-9_-]{20,}|service_role/i);
});
