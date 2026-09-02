# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.ts >> SeniorStudio >> redirects root to login
- Location: tests/e2e/app.spec.ts:4:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /.*login/
Received string:  "http://localhost:3000/"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    14 × locator resolved to <html id="__next_error__">…</html>
       - unexpected value "http://localhost:3000/"

```

```yaml
- img
- heading "This page couldn’t load" [level=1]
- paragraph: A server error occurred. Reload to try again.
- button "Reload"
- paragraph: ERROR 723568089
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | 
  3  | test.describe("SeniorStudio", () => {
  4  |   test("redirects root to login", async ({ page }) => {
  5  |     await page.goto("/");
> 6  |     await expect(page).toHaveURL(/.*login/);
     |                        ^ Error: expect(page).toHaveURL(expected) failed
  7  |     await expect(page.getByRole("heading", { name: "Welcome to SeniorStudio" })).toBeVisible();
  8  |   });
  9  | 
  10 |   test("should redirect to login when not authenticated", async ({ page }) => {
  11 |     await page.goto("/projects");
  12 |     await expect(page).toHaveURL(/.*login/);
  13 |   });
  14 | 
  15 |   test("has accessible disabled login controls and visible focus", async ({ page }) => {
  16 |     await page.goto("/login");
  17 |     const emailInput = page.getByLabel("Email address");
  18 |     const submitButton = page.getByRole("button", { name: /continue with email/i });
  19 |     await expect(emailInput).toBeVisible();
  20 |     await expect(submitButton).toBeDisabled();
  21 |     await emailInput.focus();
  22 |     await expect(emailInput).toBeFocused();
  23 |     await expect(emailInput).toHaveCSS("box-shadow", /rgb|rgba/);
  24 |   });
  25 | 
  26 |   test("fits the mobile viewport without horizontal overflow", async ({ page }) => {
  27 |     await page.setViewportSize({ width: 390, height: 844 });
  28 |     await page.goto("/login");
  29 |     const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  30 |     expect(overflow).toBeLessThanOrEqual(0);
  31 |     await expect(page.getByLabel("Email address")).toBeVisible();
  32 |   });
  33 | });
  34 | 
```