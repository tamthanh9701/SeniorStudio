// @vitest-environment node
// Cancelling a queued job commits in the RPC; cleaning up its uploaded mask is
// best-effort afterwards and must never be reported as a failed cancellation.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/env", () => ({ getEnv: () => ({ STYLE_PROFILES_ENABLED: true }) }));
vi.mock("../src/supabase/server", () => ({
  createClient: vi.fn(() => client),
  getServiceClient: vi.fn(() => serviceClient),
}));

import { POST as cancelJob } from "../src/app/api/ai-jobs/[jobId]/cancel/route";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const MASK_PATH = "11111111-1111-4111-8111-111111111111/styles/33333333-3333-4333-8333-333333333333/job-inputs/44444444-4444-4444-8444-444444444444/mask.png";

let client: Record<string, unknown>;
const remove = vi.fn();
const deleteRow = vi.fn();
const serviceClient = { storage: { from: vi.fn(() => ({ remove })) }, from: vi.fn(() => ({ delete: deleteRow })) };

function existingJob() {
  return { id: JOB_ID, input: { mask_storage_path: MASK_PATH }, status: "queued" };
}

beforeEach(() => {
  vi.clearAllMocks();
  remove.mockResolvedValue({ error: null });
  deleteRow.mockReturnValue({ eq: vi.fn(async () => ({ error: null })) });
  client = {
    auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "user-1" } }, error: null })) },
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: existingJob() })) })) })) })),
    rpc: vi.fn(async () => ({ data: { ...existingJob(), status: "canceled" }, error: null })),
  };
});

describe("POST /api/ai-jobs/[jobId]/cancel", () => {
  it("reports the cancellation even when the mask cleanup fails", async () => {
    remove.mockResolvedValue({ error: { message: "storage unavailable" } });
    const response = await cancelJob(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ jobId: JOB_ID }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.job.status).toBe("canceled");
  });

  it("reports the cancellation even when the cleanup call throws", async () => {
    remove.mockRejectedValue(new Error("socket closed"));
    const response = await cancelJob(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ job: { status: "canceled" } });
  });

  it("removes the mask object and its row after a successful cancel", async () => {
    const response = await cancelJob(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(200);
    expect(remove).toHaveBeenCalledWith([MASK_PATH]);
    expect(deleteRow).toHaveBeenCalled();
  });

  it("maps a not-found RPC error to 404, other refusals to 409, and a thrown call to 500", async () => {
    // PostgREST reports failures as plain objects: the mapping must read them
    // directly, not rely on `instanceof Error`.
    (client.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: "NOT_FOUND" } });
    const missing = await cancelJob(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
    (client.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: "JOB_RUNNING" } });
    const running = await cancelJob(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(running.status).toBe(409);
    (client.rpc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("socket closed"));
    const thrown = await cancelJob(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(thrown.status).toBe(500);
  });
});
