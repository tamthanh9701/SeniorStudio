import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("persistent profile lock recovery", () => {
  it("removes Chromium singleton artifacts before launch", async () => {
    const source = await readFile(resolve(process.cwd(), "src/chatgpt/session.ts"), "utf8");
    expect(source).toContain('"SingletonLock", "SingletonCookie", "SingletonSocket"');
    expect(source.indexOf("removeStaleProfileLocks()")).toBeLessThan(source.indexOf("chromium.launchPersistentContext"));

    const directory = await mkdtemp(join(tmpdir(), "profile-locks-"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SingletonLock"), "stale");
    expect(await readFile(join(directory, "SingletonLock"), "utf8")).toBe("stale");
  });
});
