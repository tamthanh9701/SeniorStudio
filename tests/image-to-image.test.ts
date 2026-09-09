// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const WS_ID = "11111111-1111-4111-8111-111111111111";
const STYLE_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";


const mockResolveUserWorkspaceId = vi.fn();
const mockGetModelCatalog = vi.fn();
const mockGetProviderApiKey = vi.fn();
const mockAssertModelSupports = vi.fn();

vi.mock("@/lib/ai/models", () => ({
  get resolveUserWorkspaceId() { return mockResolveUserWorkspaceId; },
  get getModelCatalog() { return mockGetModelCatalog; },
  get assertModelSupports() { return mockAssertModelSupports; },
}));

vi.mock("@/lib/ai/credentials", () => ({
  get getProviderApiKey() { return mockGetProviderApiKey; },
}));

vi.mock("@/lib/style/cost-modes", () => ({
  COST_MODE_OPTIONS: [
    { id: "balanced", preserveRequestedModel: false, styleBudget: 1600 },
    { id: "strict_style", preserveRequestedModel: true, styleBudget: 2800 },
  ],
  getReferenceLimit: () => 4,
}));

vi.mock("@/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
  getServiceClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/style/service", () => ({
  compileStyledPrompt: vi.fn(async () => "styled prompt"),
}));

vi.mock("@/lib/style/flag", () => ({
  styleProfilesEnabled: () => true,
}));



vi.mock("@/lib/ai/job-results", () => ({
  getJobResultUrls: vi.fn(async () => []),
}));

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function makeChain(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data, error }));
  chain.maybeSingle = vi.fn(async () => ({ data, error }));
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveUserWorkspaceId.mockResolvedValue(WS_ID);
  mockGetProviderApiKey.mockResolvedValue("test-key");
  mockAssertModelSupports.mockResolvedValue({
    id: "openai/gpt-image-2",
    provider: "openai",
    operations: ["text_to_image", "image_to_image", "inpaint"],
    sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
    qualities: ["low", "medium", "high", "auto"],
    maxCount: 4,
    supportsReferenceImages: true,
    maxInputImages: 4,
  });
  mockGetModelCatalog.mockResolvedValue([
    {
      id: "openai/gpt-image-2",
      provider: "openai",
      operations: ["text_to_image", "image_to_image", "inpaint"],
      sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
      qualities: ["low", "medium", "high", "auto"],
      maxCount: 4,
      supportsReferenceImages: true,
      maxInputImages: 4,
    },
    {
      id: "google/gemini-3.1-flash-image",
      provider: "google",
      operations: ["text_to_image", "image_to_image"],
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      qualities: ["auto"],
      maxCount: 4,
      supportsReferenceImages: true,
      maxInputImages: 4,
    },
  ]);
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === "style_references") return makeChain([]);
    return makeChain(null);
  });
});

describe("resolveImageExecutionPlan", () => {
  it("throws SOURCE_REQUIRED when operation is image_to_image but sourceVersionId missing", async () => {
    const { resolveImageExecutionPlan } = await import("@/lib/ai/execution-plan");
    const client = {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
      from: mockFrom,
    } as never;
    await expect(
      resolveImageExecutionPlan(client, {
        operation: "image_to_image",
        requestedModelId: "openai/gpt-image-2",
        costMode: "balanced",
        count: 1,
        size: "1024x1024",
        quality: "auto",
      })
    ).rejects.toThrow("SOURCE_REQUIRED");
  });

  it("returns correct plan with sourceVersionId populated", async () => {
    const { resolveImageExecutionPlan } = await import("@/lib/ai/execution-plan");
    const client = {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
      from: mockFrom,
    } as never;
    const plan = await resolveImageExecutionPlan(client, {
      operation: "image_to_image",
      requestedModelId: "openai/gpt-image-2",
      sourceVersionId: SOURCE_ID,
      costMode: "strict_style",
      count: 1,
      size: "1024x1024",
      quality: "auto",
    });
    expect(plan.operation).toBe("image_to_image");
    expect(plan.sourceVersionId).toBe(SOURCE_ID);
    expect(plan.effectiveModelId).toBe("openai/gpt-image-2");
    expect(plan.supported).toBe(true);
  });
});

describe("style enqueue route consent mismatch", () => {
  function jsonRequest(url: string, body?: unknown, method = "POST") {
    return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  it("rejects when consent.effectiveModelId mismatches plan", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "workspace_members") return makeChain({ workspace_id: WS_ID });
      if (table === "asset_versions") return makeChain({ id: SOURCE_ID, assets: { id: "asset-1", style_id: STYLE_ID } });
      return makeChain(null);
    });
    mockRpc.mockResolvedValue({ data: { id: "job-1" }, error: null });
    mockGetModelCatalog.mockResolvedValue([{
      id: "google/gemini-3.1-flash-image",
      provider: "google",
      operations: ["text_to_image", "image_to_image"],
      sizes: ["1024x1024"],
      qualities: ["auto"],
      maxCount: 4,
      supportsReferenceImages: true,
      maxInputImages: 4,
    }]);
    const { POST } = await import("@/app/api/style/ai-jobs/route");
    const response = await POST(jsonRequest("http://localhost/api/style/ai-jobs", {
      model: "google/gemini-3.1-flash-image",
      styleId: STYLE_ID,
      sourceVersionId: SOURCE_ID,
      consent: { effectiveModelId: "openai/gpt-image-2", referenceIds: [], styleBudget: 1600, temperature: null, modelChanged: true },
    }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("PLAN_CONSENT_MISMATCH");
  });
});

describe("OpenAI provider source+refs via images.edit", () => {
  it("calls openai.images.edit with image array for image_to_image", async () => {
    const imagesEditMock = vi.fn().mockResolvedValue({ data: [{ b64_json: Buffer.from("result").toString("base64"), revised_prompt: "revised" }] });

    vi.doMock("openai", () => ({
      default: class {
        images = { edit: imagesEditMock, generate: vi.fn() };
      },
      toFile: vi.fn(async () => new File(["x"], "image.png", { type: "image/png" })),
    }));

    const { openAiProvider } = await import("@/lib/ai/providers/openai");
    const result = await openAiProvider.submit({
      client: {} as never,
      apiKey: "test-key",
      job: {
        id: crypto.randomUUID(),
        workspace_id: WS_ID,
        project_id: crypto.randomUUID(),
        module: "projects",
        requested_by: crypto.randomUUID(),
        asset_id: null,
        parent_version_id: null,
        version_id: null,
        source_version_id: SOURCE_ID,
        operation: "image_to_image",
        provider: "openai",
        model: "openai/gpt-image-2",
        status: "submitting",
        attempt_count: 1,
        lease_owner: "worker",
        lease_expires_at: new Date().toISOString(),
        provider_request_id: null,
        provider_status: null,
        input: { prompt: "test", count: 1, size: "1024x1024", quality: "auto", reference_ids: [] },
        output: {},
        error_code: null,
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
      },
      inputImages: [
        { role: "source" as const, id: SOURCE_ID, bytes: new Uint8Array([0x89, 0x50]), mimeType: "image/png" },
      ],
    });
    expect(imagesEditMock).toHaveBeenCalled();
    expect(result.state).toBe("completed");
  });
});
