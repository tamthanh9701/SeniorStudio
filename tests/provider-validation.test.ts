// The provider check: it reports what the provider actually answered, and it never runs
// without a key. Before this route existed the settings page said "validation pending"
// forever, because nothing ever performed the validation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "user-1" } }, error: null })) },
} as unknown as Record<string, unknown>;

vi.mock("@/supabase/server", () => ({ createClient: async () => client, getServiceClient: () => ({}) }));
vi.mock("@/lib/ai/models", () => ({ resolveUserWorkspaceId: async () => "ws-1" }));

const apiKey = vi.fn<() => Promise<string | null>>(async () => "AIza-test-key");
vi.mock("@/lib/ai/credentials", () => ({ getProviderApiKey: () => apiKey() }));

import { POST } from "../src/app/api/settings/providers/validate/route";

const post = (body: unknown) => POST(new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  apiKey.mockResolvedValue("AIza-test-key");
});

describe("POST /api/settings/providers/validate", () => {
  it("reports a working Google key with the image models the catalog will find", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-flash-image" }, { name: "models/gemini-3-pro-image" }, { name: "models/text-embedding-004" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const response = await post({ provider: "google" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, models: 3, imageModels: 2 });
  });

  it("surfaces the provider's own message when the key is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const response = await post({ provider: "google" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, code: "PROVIDER_REJECTED", message: "API key not valid. Please pass a valid API key." });
  });

  it("checks OpenAI through the model list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const response = await post({ provider: "openai" });
    expect(await response.json()).toEqual({ ok: true, models: 1 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/models");
  });

  it("refuses to check a provider without a key", async () => {
    apiKey.mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await post({ provider: "openai" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_CONFIGURED" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider", async () => {
    const response = await post({ provider: "mistral" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
});
