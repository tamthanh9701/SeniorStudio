// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processAiJob } from "../src/lib/ai/worker";

const mockSubmit = vi.fn();
const mockProviderForJob = vi.fn();
const mockGetProviderApiKey = vi.fn();
const mockGetOwnedAssetVersion = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetOwnedStyleReference = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetOwnedJobMask = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockDownloadOwnedBytes = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRemoveOwnedObjects = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);

vi.mock("@/lib/ai/providers", () => ({ get providerForJob() { return mockProviderForJob; } }));
vi.mock("@/lib/ai/credentials", () => ({ get getProviderApiKey() { return mockGetProviderApiKey; } }));
vi.mock("@/lib/assets/service", () => ({ prepareImageBytes: vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png", extension: "png", width: 4, height: 4 })) }));
// The compositor needs real decodable images; naming is what this file checks.
vi.mock("@/lib/assets/inpaint-composite", () => ({
  compositeInpaintResult: vi.fn(async (_source: Uint8Array, generated: Uint8Array) => generated),
}));
vi.mock("@/lib/assets/ownership", () => ({
  getOwnedAssetVersion: (...args: unknown[]) => mockGetOwnedAssetVersion(...args),
  getOwnedStyleReference: (...args: unknown[]) => mockGetOwnedStyleReference(...args),
  getOwnedJobMask: (...args: unknown[]) => mockGetOwnedJobMask(...args),
  downloadOwnedBytes: (...args: unknown[]) => mockDownloadOwnedBytes(...args),
  removeOwnedObjects: (...args: unknown[]) => mockRemoveOwnedObjects(...args),
  ownedStorageObjectFromPath: vi.fn(),
}));

const mockRpc = vi.fn();
function supabaseClient() {
  return {
    rpc: mockRpc,
    storage: { from: vi.fn(() => ({ upload: vi.fn(async () => ({ error: null })), remove: vi.fn(async () => ({ error: null })) })) },
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.in = vi.fn(() => chain);
      chain.delete = vi.fn(() => chain);
      chain.single = vi.fn(async () => ({ data: { asset_id: "55555555-5555-4555-8555-555555555555", name: "Smoke Test Style" }, error: null }));
      chain.maybeSingle = vi.fn(async () => ({ data: { name: "Smoke Test Style" }, error: null }));
      chain.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onFulfilled);
      return chain;
    }),
  } as never;
}

const WORKER_ID = "worker-1";
const WS_ID = "11111111-1111-4111-8111-111111111111";
const STYLE_ID = "66666666-6666-4666-8666-666666666666";
const REFERENCE_ID = "77777777-7777-4777-8777-777777777777";
const VERSION_ID = "88888888-8888-4888-8888-888888888888";

function makeInpaintJob(recordedHash: string) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: WS_ID,
    project_id: null,
    module: "style",
    style_id: STYLE_ID,
    requested_by: "44444444-4444-4444-8444-444444444444",
    asset_id: "99999999-9999-4999-8999-999999999999",
    parent_version_id: VERSION_ID,
    version_id: null,
    operation: "inpaint",
    provider: "openai",
    model: "openai/gpt-image-2",
    status: "queued",
    attempt_count: 0,
    lease_owner: WORKER_ID,
    lease_expires_at: null,
    provider_request_id: null,
    provider_status: null,
    input: { prompt: "swap the cup", count: 1, size: "auto", quality: "auto", mask_id: "aaaaaaaa-1111-4111-8111-111111111111", reference_ids: [REFERENCE_ID] },
    style_generation: { packet_version: 1, reference_snapshot: [{ id: REFERENCE_ID, content_hash: recordedHash }] },
    output: {},
    error_code: null,
    error_message: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProviderForJob.mockResolvedValue({ submit: mockSubmit, poll: vi.fn(), cancel: vi.fn() });
  mockGetProviderApiKey.mockResolvedValue("test-key");
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockGetOwnedAssetVersion.mockResolvedValue({ owned: {} });
  mockGetOwnedStyleReference.mockResolvedValue({ owned: {} });
  mockGetOwnedJobMask.mockResolvedValue({ owned: {}, mask: { id: "aaaaaaaa-1111-4111-8111-111111111111" } });
  // Source, reference and mask are all downloaded through the same helper.
  mockDownloadOwnedBytes.mockResolvedValue({ bytes: new Uint8Array([9, 9, 9]), mimeType: "image/png" });
});

describe("worker reference integrity", () => {
  it("names an edit after its style instead of pasting the prompt", async () => {
    const { processAiJob } = await import("@/lib/ai/worker");
    const digest = createHash("sha256").update(new Uint8Array([9, 9, 9])).digest("hex");
    mockSubmit.mockResolvedValue({ state: "completed", images: [{ kind: "bytes", bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }], requestId: "req-1", metadata: {} });
    await processAiJob(supabaseClient(), makeInpaintJob(digest), WORKER_ID);
    const completed = mockRpc.mock.calls.find((call) => call[0] === "complete_ai_job_with_results");
    const results = completed?.[1]?.p_results as Array<{ name: string }> | undefined;
    expect(results?.[0]?.name.startsWith("Edit · ")).toBe(true);
    expect(results?.[0]?.name).not.toContain("swap the cup");
  });

  it("fails the job cleanly instead of crashing the worker", async () => {
    const { processAiJob } = await import("@/lib/ai/worker");
    const result = await processAiJob(supabaseClient(), makeInpaintJob("f".repeat(64)), WORKER_ID);
    // A crash would leave the job leased with no recorded reason.
    expect(result).toBe("failed");
    expect(mockRpc.mock.calls.filter((call) => call[0] === "fail_ai_job")).toHaveLength(1);
  });

  it("refuses to submit when a reference no longer matches the recorded hash", async () => {
    // The stored bytes hash to something other than the recorded value.
    const result = await processAiJob(supabaseClient(), makeInpaintJob("f".repeat(64)), WORKER_ID);
    expect(result).toBe("failed");
    expect(mockSubmit).not.toHaveBeenCalled();
    const failCall = mockRpc.mock.calls.find((call) => call[0] === "fail_ai_job");
    expect(failCall?.[1]).toMatchObject({ p_error_code: "REFERENCE_CONTENT_CHANGED" });
  });

  it("submits only when every reference matches its recorded hash", async () => {
    const digest = createHash("sha256").update(new Uint8Array([9, 9, 9])).digest("hex");
    mockSubmit.mockResolvedValue({ state: "completed", images: [], requestId: null, metadata: {} });
    const result = await processAiJob(supabaseClient(), makeInpaintJob(digest), WORKER_ID);
    // The empty provider response fails later, but the reference check passed.
    const failCall = mockRpc.mock.calls.find((call) => call[0] === "fail_ai_job");
    expect(failCall?.[1]).not.toMatchObject({ p_error_code: "REFERENCE_CONTENT_CHANGED" });
    expect(result).not.toBe("succeeded");
  });

  it("refuses a job whose references do not match its recorded snapshot", async () => {
    const job = makeInpaintJob("a".repeat(64));
    (job.input as Record<string, unknown>).reference_ids = [REFERENCE_ID, "bbbbbbbb-2222-4222-8222-222222222222"];
    const result = await processAiJob(supabaseClient(), job, WORKER_ID);
    expect(result).toBe("failed");
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
