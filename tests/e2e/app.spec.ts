import { test, expect } from "@playwright/test";

test.describe("SeniorStudio", () => {
  test("redirects root to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/.*login/);
    await expect(page.getByRole("heading", { name: "Welcome to SeniorStudio" })).toBeVisible();
  });

  test("should redirect to login when not authenticated", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveURL(/.*login/);
  });

  test("has accessible disabled login controls and visible focus", async ({ page }) => {
    await page.goto("/login");
    const emailInput = page.getByLabel("Email address");
    const submitButton = page.getByRole("button", { name: /sign in/i });
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(submitButton).toBeDisabled();
    await emailInput.focus();
    await expect(emailInput).toBeFocused();
    await expect(emailInput).toHaveCSS("box-shadow", /rgb|rgba/);
  });

  test("fits the mobile viewport without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByLabel("Email address")).toBeVisible();
  });
});
