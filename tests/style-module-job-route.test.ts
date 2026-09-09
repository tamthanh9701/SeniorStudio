// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/env", () => ({
  getEnv: () => ({ STYLE_PROFILES_ENABLED: true }),
}));
vi.mock("../src/lib/style/flag", () => ({
  styleProfilesEnabled: () => true,
}));
vi.mock("../src/lib/ai/models", () => ({
  assertModelSupports: vi.fn(async (model: string) => ({ id: model, provider: "google", sizes: ["1024x1024"], qualities: ["auto"] })),
}));
vi.mock("../src/lib/ai/credentials", () => ({
  getProviderApiKey: vi.fn(async () => "test-api-key"),
}));
vi.mock("../src/lib/ai/quota-reservation", () => ({
  reserveImageQuota: vi.fn(async () => "reservation-id"),
}));
vi.mock("../src/lib/ai/execution-plan", () => ({
  resolveImageExecutionPlan: vi.fn(async () => ({
    operation: "image_to_image",
    requestedModelId: "google/gemini-2.5-flash-image",
    effectiveModelId: "google/gemini-2.5-flash-image",
    provider: "google",
    size: "1024x1024",
    quality: "auto",
    count: 1,
    styleBudget: 1600,
    referenceIds: [],
    sourceVersionId: "66666666-6666-4666-8666-666666666666",
    temperature: null,
    modelChanged: false,
    explanation: "requested",
    supported: true,
  })),
}));
vi.mock("../src/supabase/server", () => ({
  createClient: vi.fn(() => client),
  getServiceClient: vi.fn(() => serviceClient),
}));

import { GET, POST } from "../src/app/api/style/ai-jobs/route";
import { compileStyledPrompt } from "../src/lib/style/service";
vi.mock("../src/lib/style/service", () => ({
  compileStyledPrompt: vi.fn(async () => "styled prompt"),
}));

function builder(final: unknown, overrides: Record<string, unknown> = {}) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "order", "limit", "insert", "update", "delete"]) {
    node[method] = vi.fn(() => node);
  }
  node.single = vi.fn(async () => final);
  node.maybeSingle = vi.fn(async () => final);
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(final).then(onFulfilled);
  return Object.assign(node, overrides);
}

const serviceClient = { storage: { from: vi.fn() } };

const jobRow = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: null,
  module: "style",
  requested_by: "44444444-4444-4444-8444-444444444444",
  asset_id: null,
  parent_version_id: null,
  version_id: null,
  operation: "text_to_image",
  provider: "google",
  model: "google/gemini-2.5-flash-image",
  status: "queued",
  attempt_count: 0,
  lease_owner: null,
  lease_expires_at: null,
  provider_request_id: null,
  provider_status: null,
  input: { prompt: "styled", count: 1, size: "1024x1024", quality: "auto", style_id: "55555555-5555-4555-8555-555555555555", original_prompt: null },
  output: {},
  error_code: null,
  error_message: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
};

function jsonRequest(url: string, body?: unknown, method = "POST") {
  return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

interface MockClient {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
}
let client: MockClient;

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: vi.fn(),
    rpc: vi.fn(),
  };
});

describe("GET /api/style/ai-jobs", () => {
  it("returns 401 when unauthenticated", async () => {
    (client.auth as { getUser: () => Promise<{ data: { user: null } }> }).getUser = vi.fn(async () => ({ data: { user: null } }));
    const response = await GET(new Request("http://localhost/api/style/ai-jobs"));
    expect(response.status).toBe(401);
  });

  it("scopes the feed to module=style jobs with a style_id", async () => {
    const feed = builder({ data: [jobRow], error: null });
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue(feed);
    const response = await GET(new Request("http://localhost/api/style/ai-jobs"));
    expect(response.status).toBe(200);
    expect(client.from).toHaveBeenCalledWith("ai_jobs");
    const body = await response.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].job.input.style_id).toBe("55555555-5555-4555-8555-555555555555");
  });
});

describe("POST /api/style/ai-jobs", () => {
  const validPayload = {
    model: "google/gemini-2.5-flash-image",
    styleId: "55555555-5555-4555-8555-555555555555",
    sourceVersionId: "66666666-6666-4666-8666-666666666666",
    consent: { effectiveModelId: "google/gemini-2.5-flash-image", referenceIds: [], styleBudget: 1600, temperature: null, modelChanged: false },
  };

  it("rejects invalid payloads with 400", async () => {
    for (const body of [{ model: "", styleId: "nope" }, { styleId: "55555555-5555-4555-8555-555555555555" }, null]) {
      const response = await POST(jsonRequest("http://localhost/api/style/ai-jobs", body));
      expect(response.status).toBe(400);
    }
  });

  it("enqueues with p_module=style, p_project_id=null and p_style_id", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "workspace_members") return builder({ data: { workspace_id: "ws-1" }, error: null });
      if (table === "asset_versions") return builder({ data: { id: validPayload.sourceVersionId, assets: { id: "asset-1", style_id: validPayload.styleId } }, error: null });
      return builder({ data: null, error: null });
    });
    (client.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: jobRow, error: null });
    const response = await POST(jsonRequest("http://localhost/api/style/ai-jobs", validPayload));
    expect(response.status).toBe(202);
    expect(client.rpc).toHaveBeenCalledWith("enqueue_image_to_image_job_v2", expect.objectContaining({
      p_workspace_id: "ws-1",
      p_style_id: "55555555-5555-4555-8555-555555555555",
    }));
  });

  it("returns 404 when caller has no workspace", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "workspace_members") return builder({ data: null, error: null });
      return builder({ data: null, error: null });
    });
    const response = await POST(jsonRequest("http://localhost/api/style/ai-jobs", validPayload));
    expect(response.status).toBe(404);
  });
});
