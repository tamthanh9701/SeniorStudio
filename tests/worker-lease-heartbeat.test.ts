// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withLeaseHeartbeat } from "../src/lib/ai/worker";

/**
 * The heartbeat is the only thing keeping a long provider call alive.  Latching
 * a transient renewal failure used to stop all renewals, so the lease expired
 * while the call was still running and the job was reported as an unknown
 * provider outcome.
 */
const JOB = { id: "22222222-2222-4222-8222-222222222222", workspace_id: "11111111-1111-4111-8111-111111111111" } as never;

function clientWithRenewals(outcomes: Array<{ error: unknown }>) {
  const renew = vi.fn(async () => outcomes.shift() ?? { error: null });
  return { client: { rpc: vi.fn((name: string) => (name === "renew_ai_job_lease" ? renew() : Promise.resolve({ error: null }))) } as never, renew };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

describe("withLeaseHeartbeat", () => {
  it("keeps renewing after a transient failure instead of giving up", async () => {
    const { client, renew } = clientWithRenewals([
      { error: null },                                  // entry
      { error: { message: "connection reset" } },       // transient at 30s
      { error: null },                                  // recovered at 60s
    ]);
    const task = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
      return "done";
    });

    await expect(withLeaseHeartbeat(client, JOB, "worker-1", task)).resolves.toBe("done");
    // entry + 30s + 60s (a latched failure would have stopped after the second)
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("treats a proven lease loss as fatal before persisting", async () => {
    const { client } = clientWithRenewals([
      { error: null },
      { error: { message: "LEASE_NOT_OWNED" } },
    ]);
    const task = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      return "done";
    });

    await expect(withLeaseHeartbeat(client, JOB, "worker-1", task)).rejects.toMatchObject({ message: "LEASE_NOT_OWNED" });
  });

  it("verifies the lease once more when the last renewal failed", async () => {
    const { client, renew } = clientWithRenewals([
      { error: null },
      { error: { message: "connection reset" } },
    ]);
    const task = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      return "done";
    });

    await expect(withLeaseHeartbeat(client, JOB, "worker-1", task)).resolves.toBe("done");
    // entry, the failed one, and the confirming renewal before persistence
    expect(renew).toHaveBeenCalledTimes(3);
  });
});
