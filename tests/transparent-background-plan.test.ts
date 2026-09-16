// @vitest-environment node
// A transparent-background request must never reach a provider that cannot
// honour it: the image would come back opaque after being paid for. Google's
// image models are not configured in this workspace, so the rule is pinned here
// rather than through the API.
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.fn<(client: unknown, workspaceId: unknown) => Promise<readonly unknown[]>>();
const providerKey = vi.fn<(provider: unknown, source: unknown) => Promise<string>>(async () => "key");

vi.mock("../src/lib/ai/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/models")>();
  return { ...actual, getModelCatalog: (client: unknown, workspaceId: unknown) => catalog(client, workspaceId), resolveUserWorkspaceId: async () => "11111111-1111-4111-8111-111111111111" };
});
vi.mock("../src/lib/ai/credentials", () => ({ getProviderApiKey: (provider: unknown, source: unknown) => providerKey(provider, source) }));

import { resolveImageExecutionPlan } from "../src/lib/ai/execution-plan";
import { INPAINT_MODELS } from "../src/lib/ai/models";

const client = { auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "user-1" } }, error: null })) } } as never;
const request = {
  operation: "image_to_image" as const,
  requestedModelId: "openai/gpt-image-2",
  prompt: "remove the background",
  count: 1,
  size: "auto",
  quality: "auto",
  costMode: "strict_1000" as const,
  preserveRequestedModel: true,
  sourceVersionId: "22222222-2222-4222-8222-222222222222",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transparent background capability", () => {
  it("refuses a model that cannot return a transparent background", async () => {
    catalog.mockResolvedValue([{ ...INPAINT_MODELS[0], id: "google/gemini-3-pro-image", provider: "google", sizes: ["1024x1024"], qualities: ["auto"], supportsTransparentBackground: undefined }]);
    await expect(resolveImageExecutionPlan(client, { ...request, requestedModelId: "google/gemini-3-pro-image", background: "transparent" }))
      .rejects.toThrow(/transparent background/);
  });

  it("allows it on a capable model and keeps the request otherwise unchanged", async () => {
    catalog.mockResolvedValue(INPAINT_MODELS);
    const plan = await resolveImageExecutionPlan(client, { ...request, background: "transparent" });
    expect(plan.effectiveModelId).toBe("openai/gpt-image-2");
    expect(plan.sourceVersionId).toBe(request.sourceVersionId);
  });

  it("does not care about the capability when no background was requested", async () => {
    catalog.mockResolvedValue([{ ...INPAINT_MODELS[0], id: "google/gemini-3-pro-image", provider: "google", sizes: ["1024x1024"], qualities: ["auto"], supportsTransparentBackground: undefined }]);
    // Google models in this catalog accept only explicit sizes, so the request uses one.
    const plan = await resolveImageExecutionPlan(client, { ...request, requestedModelId: "google/gemini-3-pro-image", size: "1024x1024" });
    expect(plan.effectiveModelId).toBe("google/gemini-3-pro-image");
  });
});
