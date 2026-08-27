import { test, expect } from "@playwright/test";

test.describe("SeniorStudio", () => {
  test("should show login page", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("h1")).toContainText("SeniorStudio");
  });

  test("should redirect to login when not authenticated", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveURL(/.*login/);
  });

  test("should have accessible controls", async ({ page }) => {
    await page.goto("/login");
    
    // Check for form elements
    const emailInput = page.locator("input[type='email']");
    await expect(emailInput).toBeVisible();
    
    const submitButton = page.locator("button[type='submit']");
    await expect(submitButton).toBeVisible();
    
    // Check keyboard accessibility
    await emailInput.focus();
    await expect(emailInput).toBeFocused();
  });
});
