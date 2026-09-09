// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSubmit = vi.fn();
const mockPoll = vi.fn();
const mockProviderForJob = vi.fn();
const mockGetProviderApiKey = vi.fn();
const mockPrepareImageBytes = vi.fn();

vi.mock("@/lib/ai/providers", () => ({
  get providerForJob() { return mockProviderForJob; },
}));
vi.mock("@/lib/ai/credentials", () => ({
  get getProviderApiKey() { return mockGetProviderApiKey; },
}));
vi.mock("@/lib/assets/service", () => ({
  get prepareImageBytes() { return mockPrepareImageBytes; },
}));

const mockRpc = vi.fn();
const mockUpload = vi.fn();
const mockRemove = vi.fn();
const mockStorageFrom = vi.fn(() => ({ upload: mockUpload, remove: mockRemove, download: vi.fn() }));
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockIn = vi.fn();
const mockSingle = vi.fn();
const mockDelete = vi.fn();

function supabaseClient() {
  return {
    rpc: mockRpc,
    storage: { from: mockStorageFrom },
    from: vi.fn(() => ({ select: mockSelect, eq: mockEq, in: mockIn, single: mockSingle, delete: mockDelete })),
  } as never;
}

const WORKER_ID = "worker-1";
const WS_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    workspace_id: WS_ID,
    project_id: "33333333-3333-4333-8333-333333333333",
    module: "projects",
    requested_by: "44444444-4444-4444-8444-444444444444",
    asset_id: null,
    parent_version_id: null,
    version_id: null,
    operation: "text_to_image",
    provider: "openai",
    model: "openai/gpt-image-2",
    status: "queued",
    attempt_count: 0,
    lease_owner: WORKER_ID,
    lease_expires_at: null,
    provider_request_id: null,
    provider_status: null,
    input: { prompt: "test prompt", count: 1, size: "1024x1024", quality: "auto" },
    output: {},
    error_code: null,
    error_message: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

const provider = { submit: mockSubmit, poll: mockPoll, cancel: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mockProviderForJob.mockResolvedValue(provider);
  mockGetProviderApiKey.mockResolvedValue("test-key");
  mockSubmit.mockResolvedValue({ state: "completed", images: [{ kind: "bytes", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" }], requestId: null, metadata: {} });
  mockPrepareImageBytes.mockResolvedValue({ bytes: new Uint8Array([0x89]), mimeType: "image/png", extension: "png", width: 1, height: 1 });
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockUpload.mockResolvedValue({ error: null });
  mockRemove.mockResolvedValue({ error: null });
  mockSelect.mockReturnValue({ select: mockSelect, eq: mockEq, in: mockIn, single: mockSingle });
  mockEq.mockReturnValue({ select: mockSelect, eq: mockEq, in: mockIn, single: mockSingle });
  mockIn.mockReturnValue({ select: mockSelect, eq: mockEq, in: mockIn, single: mockSingle });
  mockSingle.mockResolvedValue({ data: null, error: null });
});

describe("processAiJob", () => {
  it("calls begin_ai_job_provider before provider.submit", async () => {
    const { processAiJob } = await import("@/lib/ai/worker");
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(), WORKER_ID);
    expect(result).toBe("succeeded");
    const rpcCalls = mockRpc.mock.calls.map((call) => String(call[0]));
    const beginIdx = rpcCalls.indexOf("begin_ai_job_provider");
    const renewIdx = rpcCalls.indexOf("renew_ai_job_lease");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(mockSubmit).toHaveBeenCalled();
  });

  it("calls resolve_ai_job_persistence on completion RPC error and keeps files when committed", async () => {
    const { processAiJob } = await import("@/lib/ai/worker");
    let callCount = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "renew_ai_job_lease") return { error: null };
      if (name === "begin_ai_job_provider") return { error: null };
      if (name === "complete_ai_job_with_results") return { error: { message: "race" } };
      if (name === "resolve_ai_job_persistence") return { data: { state: "committed" }, error: null };
      if (name === "set_ai_job_persisting") return { error: null };
      return { error: null };
    });
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(), WORKER_ID);
    expect(result).toBe("succeeded");
    expect(mockRemove).not.toHaveBeenCalled();
    const rpcNames = mockRpc.mock.calls.map((call) => String(call[0]));
    expect(rpcNames).toContain("resolve_ai_job_persistence");
  });

  it("calls resolve_ai_job_persistence on completion RPC error and removes files when aborted", async () => {
    const { processAiJob } = await import("@/lib/ai/worker");
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "renew_ai_job_lease") return { error: null };
      if (name === "begin_ai_job_provider") return { error: null };
      if (name === "set_ai_job_persisting") return { error: null };
      if (name === "complete_ai_job_with_results") return { error: { message: "race" } };
      if (name === "resolve_ai_job_persistence") return { data: { state: "aborted" }, error: null };
      return { error: null };
    });
    const client = supabaseClient();
    await expect(processAiJob(client, makeJob(), WORKER_ID)).rejects.toThrow();
    expect(mockRemove).toHaveBeenCalled();
  });

  it("returns failed with PROVIDER_NOT_CONFIGURED when apiKey is missing", async () => {
    mockGetProviderApiKey.mockResolvedValue(null);
    const { processAiJob } = await import("@/lib/ai/worker");
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(), WORKER_ID);
    expect(result).toBe("failed");
    const failCalls = mockRpc.mock.calls.filter((call) => call[0] === "fail_ai_job");
    expect(failCalls.length).toBe(1);
    expect(failCalls[0][1]).toMatchObject({ p_error_code: "PROVIDER_NOT_CONFIGURED" });
  });
});

describe("failJob (via processAiJob error path)", () => {
  it("returns lease_lost when fail_ai_job RPC error contains LEASE_NOT_OWNED", async () => {
    mockGetProviderApiKey.mockResolvedValue("key");
    mockSubmit.mockRejectedValue(new Error("something bad"));
    mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "renew_ai_job_lease") return { error: null };
      if (name === "begin_ai_job_provider") return { error: null };
      if (name === "fail_ai_job") return { error: { message: "relation ... does not exist ... LEASE_NOT_OWNED ..." } };
      return { error: null };
    });
    const { processAiJob } = await import("@/lib/ai/worker");
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(), WORKER_ID);
    expect(result).toBe("lease_lost");
  });
});

describe("persistJobImages", () => {
  it("keeps uploaded files when persistence outcome is unknown", async () => {
    mockGetProviderApiKey.mockResolvedValue("key");
    mockSubmit.mockResolvedValue({ state: "completed", images: [{ kind: "bytes", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" }], requestId: null, metadata: {} });
    mockPrepareImageBytes.mockResolvedValue({ bytes: new Uint8Array([0x89]), mimeType: "image/png", extension: "png", width: 1, height: 1 });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "renew_ai_job_lease") return { error: null };
      if (name === "begin_ai_job_provider") return { error: null };
      if (name === "set_ai_job_persisting") return { error: null };
      if (name === "complete_ai_job_with_results") return { error: { message: "database insert failed" } };
      if (name === "resolve_ai_job_persistence") return { data: null, error: { message: "rpc unavailable" } };
      if (name === "fail_ai_job") return { error: null };
      return { error: null };
    });
    const { processAiJob } = await import("@/lib/ai/worker");
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(), WORKER_ID);
    expect(result).toBe("failed");
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
