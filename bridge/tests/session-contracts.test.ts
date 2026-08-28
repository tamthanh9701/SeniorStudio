import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("persistent browser session contracts", () => {
  const session = readFileSync(resolve(process.cwd(), "src/chatgpt/session.ts"), "utf8");
  const worker = readFileSync(resolve(process.cwd(), "src/worker.ts"), "utf8");

  it("treats a visible login control as needs_login even when guest composer exists", () => {
    expect(session.indexOf("signIn.first().isVisible")).toBeLessThan(session.indexOf("findComposer(page, 10_000)"));
  });

  it("starts the persistent browser while idle for manual noVNC login", () => {
    expect(worker).toContain("await this.session.start()");
  });
});
