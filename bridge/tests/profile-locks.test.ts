import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("persistent profile lock recovery", () => {
  it("clears Chromium singleton artifacts before the desktop process starts", () => {
    const entrypoint = readFileSync(resolve(process.cwd(), "entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("SingletonLock");
    expect(entrypoint.indexOf("rm -f /data/chrome-profile/SingletonLock")).toBeLessThan(entrypoint.indexOf("--remote-debugging-port=9222"));
  });
});
