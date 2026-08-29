import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("stable desktop Chrome image", () => {
  it("installs and launches Google Chrome Stable without exposing CDP", () => {
    const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");
    const entrypoint = readFileSync(resolve(process.cwd(), "entrypoint.sh"), "utf8");
    expect(dockerfile).toContain("google-chrome-stable");
    expect(entrypoint).toContain("/usr/bin/google-chrome-stable");
    expect(entrypoint).toContain("--remote-debugging-address=127.0.0.1");
    expect(entrypoint).not.toContain("--disable-blink-features");
    expect(entrypoint).not.toContain("navigator.webdriver");
  });
});
