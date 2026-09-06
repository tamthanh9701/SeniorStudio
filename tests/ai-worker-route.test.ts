import { describe, expect, it, vi } from "vitest";

vi.mock("../src/env", () => ({ getEnv: () => ({ AI_WORKER_SECRET: "worker-secret" }) }));
vi.mock("../src/supabase/server", () => ({ getServiceClient: vi.fn() }));
vi.mock("../src/lib/ai/worker", () => ({ processAiJob: vi.fn() }));

import { POST } from "../src/app/api/internal/ai-worker/route";

describe("private AI worker route", () => {
  it("rejects an invalid secret before claiming jobs", async () => {
    const response = await POST(new Request("http://localhost/api/internal/ai-worker", { method: "POST", headers: { Authorization: "Bearer wrong" } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
  });
});
