import { beforeEach, describe, expect, it, vi } from "vitest";

const generate = vi.fn();
const edit = vi.fn();
const interactionCreate = vi.fn();
vi.mock("openai", () => ({
  default: class { images = { generate, edit }; },
  toFile: vi.fn(async () => new File(["x"], "image.png", { type: "image/png" })),
}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class { interactions = { create: interactionCreate }; },
}));
vi.mock("../src/env", () => ({
  requireOpenAIKey: () => "test",
  requireGeminiKey: () => "gemini-test",
  getEnv: () => ({ OPENAI_IMAGE_MODEL: "gpt-image-2", GOOGLE_IMAGE_MODEL: "gemini-3.1-flash-image" }),
}));

import { openAiProvider } from "../src/lib/ai/providers/openai";
import { googleProvider } from "../src/lib/ai/providers/google";

describe("provider adapters", () => {
  beforeEach(() => { generate.mockReset(); edit.mockReset(); interactionCreate.mockReset(); });

  it("decodes OpenAI base64 image bytes without URL ingestion", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64"), revised_prompt: "revised" }] });
    const result = await openAiProvider.submit({
      client: {} as never, apiKey: "test-key", job: {
        id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), project_id: crypto.randomUUID(), requested_by: crypto.randomUUID(),
        asset_id: null, parent_version_id: null, version_id: null, operation: "text_to_image", provider: "openai", model: "openai/gpt-image-2",
        status: "submitting", attempt_count: 1, lease_owner: "worker", lease_expires_at: new Date().toISOString(), provider_request_id: null,
        provider_status: null, input: { prompt: "test", count: 1, size: "1024x1024", quality: "auto" }, output: {}, error_code: null,
        error_message: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null,
      },
    });
    expect(result.state).toBe("completed");
    if (result.state === "completed") {
      const image = result.images[0];
      expect(image).toMatchObject({ kind: "bytes", contentType: "image/png" });
      if (!image || image.kind !== "bytes") throw new Error("Expected byte image");
      expect(Buffer.from(image.bytes).toString()).toBe("png-bytes");
      expect(result.metadata.revised_prompt).toBe("revised");
    }
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-image-2", response_format: "b64_json" }));
  });

  it("rejects polling for the synchronous OpenAI adapter", async () => {
    await expect(openAiProvider.poll({} as never)).rejects.toMatchObject({ code: "INVALID_PROVIDER_STATE" });
  });

  it("submits one Google interaction per requested image", async () => {
    interactionCreate.mockResolvedValue({
      id: "interaction-1",
      output_image: { type: "image", data: Buffer.from("google-image").toString("base64"), mime_type: "image/png" },
    });
    const result = await googleProvider.submit({
      client: {} as never, apiKey: "test-key", job: {
        id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), project_id: crypto.randomUUID(), requested_by: crypto.randomUUID(),
        asset_id: null, parent_version_id: null, version_id: null, operation: "text_to_image", provider: "google", model: "google/gemini-3.1-flash-image",
        status: "submitting", attempt_count: 1, lease_owner: "worker", lease_expires_at: new Date().toISOString(), provider_request_id: null,
        provider_status: null, input: { prompt: "test", count: 2, size: "1536x1024", quality: "auto" }, output: {}, error_code: null,
        error_message: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null,
      },
    });
    expect(interactionCreate).toHaveBeenCalledTimes(2);
    expect(interactionCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.1-flash-image", store: false,
      response_format: expect.objectContaining({ type: "image", mime_type: "image/jpeg", aspect_ratio: "3:2", image_size: "1K" }),
    }));
    expect(result.state).toBe("completed");
    if (result.state === "completed") expect(result.images).toHaveLength(2);
  });
});
