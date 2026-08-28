import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgePageError, extractAssistantText, extractImage, saveDiagnostics } from "../src/chatgpt/page.js";
function turn(text: string, images: Array<{ width: number; height: number }> = []) {
  return {
    innerText: async () => text,
    locator: () => ({
      count: async () => images.length,
      nth: (index: number) => ({ evaluate: async () => images[index] }),
    }),
    getByRole: () => ({ first: () => ({ isVisible: async () => false }) }),
  } as never;
}

describe("ChatGPT extraction fences", () => {
  it("strips UI labels and caps assistant text", async () => {
    const text = await extractAssistantText(turn(`Caption\nCopy\nShare\n${"x".repeat(40000)}`));
    expect(text).not.toContain("Copy");
    expect(text.length).toBe(32768);
  });

  it("rejects zero and multiple generated images", async () => {
    const page = {} as never;
    await expect(extractImage(page, turn("caption"))).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND", review: false });
    await expect(extractImage(page, turn("caption", [{ width: 512, height: 512 }, { width: 512, height: 512 }]))).rejects.toMatchObject({ code: "MULTIPLE_IMAGES", review: true });
  });

  it("exposes stable diagnostic error shape", () => {
    expect(new BridgePageError("CHATGPT_UI_CHANGED", "changed")).toMatchObject({ code: "CHATGPT_UI_CHANGED", review: true });
  });

  it("writes screenshot and sanitized DOM artifacts for UI changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seniorstudio-diagnostics-"));
    const page = {
      screenshot: async ({ path }: { path: string }) => { await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "png")); },
      locator: () => ({ evaluate: async () => '<body><input value="secret"></body>' }),
    } as never;
    const artifacts = await saveDiagnostics(page, directory, "job-id");
    expect(await readFile(artifacts.screenshot, "utf8")).toBe("png");
    expect(await readFile(artifacts.dom, "utf8")).toContain('value="[redacted]"');
  });
});
