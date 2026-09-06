import { beforeEach, describe, expect, it, vi } from "vitest";

const modelsList = vi.fn();
const maybeSingle = vi.fn<() => Promise<{ data: { api_key: string } | null }>>(async () => ({ data: { api_key: "gemini-test" } }));
const catalogClient = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) } as never;

vi.mock("@google/genai", () => ({
  GoogleGenAI: class { models = { list: modelsList }; },
}));

import { assertModelSupports, getModelCatalog } from "../src/lib/ai/models";

describe("AI model catalog", () => {
  beforeEach(() => {
    modelsList.mockReset();
    modelsList.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { name: "models/gemini-3.1-flash-image", displayName: "Nano Banana 2" };
        yield { name: "models/gemini-3.1-flash-lite-image", displayName: "Nano Banana 2 Lite" };
        yield { name: "models/gemini-3-pro-image", displayName: "Nano Banana Pro" };
        yield { name: "models/gemini-2.5-flash-image", displayName: "Nano Banana" };
        yield { name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" };
      },
    });
  });

  it("returns Google image models when a provider key is configured", async () => {
    expect((await getModelCatalog(catalogClient)).map((model) => model.id)).toEqual([
      "openai/gpt-image-2",
      "google/gemini-3.1-flash-image",
      "google/gemini-3.1-flash-lite-image",
      "google/gemini-3-pro-image",
      "google/gemini-2.5-flash-image",
    ]);
  });

  it("returns only OpenAI when Google is unconfigured", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null });
    expect((await getModelCatalog(catalogClient)).map((model) => model.id)).toEqual(["openai/gpt-image-2"]);
  });

  it("rejects non-image and incompatible operation combinations", async () => {
    await expect(assertModelSupports("google/gemini-3.7-flash", "text_to_image")).rejects.toThrow("INVALID_MODEL");
    await expect(assertModelSupports("google/gemini-3.1-flash-image", "inpaint")).rejects.toThrow("INVALID_MODEL");
    expect((await assertModelSupports("openai/gpt-image-2", "inpaint")).provider).toBe("openai");
  });
});
