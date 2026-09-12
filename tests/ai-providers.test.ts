import { beforeEach, describe, expect, it, vi } from "vitest";

const generate = vi.fn();
const edit = vi.fn();
const interactionCreate = vi.fn();
vi.mock("openai", () => ({
  default: class { images = { generate, edit }; },
  toFile: vi.fn(async (bytes: Uint8Array | Buffer, name: string, options: { type: string }) => new File([bytes as BlobPart], name, options)),
}));
vi.mock("sharp", () => ({
  default: vi.fn((bytes: Uint8Array | Buffer) => {
    const pipeline = {
      metadata: vi.fn(async () => ({ width: 1, height: 1 })),
      ensureAlpha: vi.fn(() => pipeline),
      png: vi.fn(() => pipeline),
      toBuffer: vi.fn(async () => Buffer.from(bytes)),
    };
    return pipeline;
  }),
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
import type { AiJob, AiOperation } from "../src/db/ai-jobs";

function job(operation: AiOperation, provider: "openai" | "google", model: "openai/gpt-image-2" | "google/gemini-3.1-flash-image", count: 1 | 2 = 1): AiJob {
  return {
    id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), project_id: crypto.randomUUID(), module: "projects", requested_by: crypto.randomUUID(),
    asset_id: null, parent_version_id: null, version_id: null, operation, provider, model,
    status: "submitting", attempt_count: 1, lease_owner: "worker", lease_expires_at: new Date().toISOString(), provider_request_id: null,
    provider_status: null, input: { prompt: "test", count, size: "1024x1024", quality: "auto" }, output: {}, error_code: null,
    error_message: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null,
  };
}

describe("provider adapters", () => {
  beforeEach(() => { generate.mockReset(); edit.mockReset(); interactionCreate.mockReset(); });

  it("decodes OpenAI base64 image bytes without URL ingestion", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64"), revised_prompt: "revised" }] });
    const result = await openAiProvider.submit({
      client: {} as never, apiKey: "test-key", job: {
        id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), project_id: crypto.randomUUID(), module: "projects", requested_by: crypto.randomUUID(),
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
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-image-2", quality: "auto" }));
    expect(generate.mock.calls[0][0]).not.toHaveProperty("response_format");
  });

  it("dispatches source-less OpenAI text_to_image references to images.edit in input order", async () => {
    edit.mockResolvedValue({ data: [{ b64_json: Buffer.from("edited").toString("base64") }] });
    const signal = new AbortController().signal;
    await openAiProvider.submit({
      client: {} as never,
      apiKey: "test-key",
      job: job("text_to_image", "openai", "openai/gpt-image-2"),
      signal,
      inputImages: [
        { role: "reference", id: "r2", bytes: new Uint8Array([2]), mimeType: "image/png" },
        { role: "reference", id: "r1", bytes: new Uint8Array([1]), mimeType: "image/png" },
      ],
    });

    expect(generate).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    const [request, options] = edit.mock.calls[0];
    expect(options).toEqual({ signal });
    expect(request).not.toHaveProperty("mask");
    expect(await Promise.all((request.image as File[]).map((image) => image.arrayBuffer().then((bytes) => new Uint8Array(bytes)[0])))).toEqual([2, 1]);
  });

  it("orders OpenAI image_to_image as source then references", async () => {
    edit.mockResolvedValue({ data: [{ b64_json: Buffer.from("edited").toString("base64") }] });
    await openAiProvider.submit({
      client: {} as never,
      apiKey: "test-key",
      job: job("image_to_image", "openai", "openai/gpt-image-2"),
      inputImages: [
        { role: "reference", id: "r2", bytes: new Uint8Array([2]), mimeType: "image/png" },
        { role: "source", id: "source", bytes: new Uint8Array([9]), mimeType: "image/png" },
        { role: "reference", id: "r1", bytes: new Uint8Array([1]), mimeType: "image/png" },
      ],
    });

    const request = edit.mock.calls[0][0];
    expect(await Promise.all((request.image as File[]).map((image) => image.arrayBuffer().then((bytes) => new Uint8Array(bytes)[0])))).toEqual([9, 2, 1]);
  });

  it("orders OpenAI inpaint as source then references and applies the mask to the first image", async () => {
    edit.mockResolvedValue({ data: [{ b64_json: Buffer.from("edited").toString("base64") }] });
    const signal = new AbortController().signal;
    await openAiProvider.submit({
      client: {} as never,
      apiKey: "test-key",
      job: job("inpaint", "openai", "openai/gpt-image-2"),
      signal,
      maskBytes: new Uint8Array([7]),
      inputImages: [
        { role: "reference", id: "r2", bytes: new Uint8Array([2]), mimeType: "image/png" },
        { role: "source", id: "source", bytes: new Uint8Array([9]), mimeType: "image/png" },
        { role: "reference", id: "r1", bytes: new Uint8Array([1]), mimeType: "image/png" },
      ],
    });

    const [request, options] = edit.mock.calls[0];
    expect(options).toEqual({ signal });
    expect(await Promise.all((request.image as File[]).map((image) => image.arrayBuffer().then((bytes) => new Uint8Array(bytes)[0])))).toEqual([9, 2, 1]);
    expect(new Uint8Array(await (request.mask as File).arrayBuffer())).toEqual(new Uint8Array([7]));
  });

  it("rejects malformed OpenAI source combinations before provider calls", async () => {
    await expect(openAiProvider.submit({
      client: {} as never,
      apiKey: "test-key",
      job: job("text_to_image", "openai", "openai/gpt-image-2"),
      inputImages: [{ role: "source", id: "source", bytes: new Uint8Array([9]), mimeType: "image/png" }],
    })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "text_to_image does not accept a source image" });
    await expect(openAiProvider.submit({
      client: {} as never,
      apiKey: "test-key",
      job: job("image_to_image", "openai", "openai/gpt-image-2"),
      inputImages: [],
    })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "image_to_image requires exactly one source image in context" });
    expect(generate).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
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
        id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), project_id: crypto.randomUUID(), module: "projects", requested_by: crypto.randomUUID(),
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

  it("orders Google contents as prompt, source, then references", async () => {
    interactionCreate.mockResolvedValue({
      id: "interaction-ordered",
      output_image: { type: "image", data: Buffer.from("google-image").toString("base64"), mime_type: "image/png" },
    });
    const signal = new AbortController().signal;
    await googleProvider.submit({
      client: {} as never,
      apiKey: "test-key",
      job: job("image_to_image", "google", "google/gemini-3.1-flash-image"),
      signal,
      inputImages: [
        { role: "reference", id: "r2", bytes: new Uint8Array([2]), mimeType: "image/png" },
        { role: "source", id: "source", bytes: new Uint8Array([9]), mimeType: "image/jpeg" },
        { role: "reference", id: "r1", bytes: new Uint8Array([1]), mimeType: "image/webp" },
      ],
    });

    expect(interactionCreate).toHaveBeenCalledWith({
      model: "gemini-3.1-flash-image",
      input: [
        { type: "text", text: "test" },
        { type: "image", data: Buffer.from([9]).toString("base64"), mime_type: "image/jpeg" },
        { type: "image", data: Buffer.from([2]).toString("base64"), mime_type: "image/png" },
        { type: "image", data: Buffer.from([1]).toString("base64"), mime_type: "image/webp" },
      ],
      store: false,
      labels: { output_index: "0" },
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "1:1", image_size: "1K" },
    }, { signal, timeout: 150_000, maxRetries: 0 });
  });
});
