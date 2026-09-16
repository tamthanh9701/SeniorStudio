// @vitest-environment node
// Races and leases a single connection cannot observe: two sessions claiming at the
// same moment, a lease only its owner may renew or start, a claim that is never
// handed out twice, and an expired lease that fails the job while returning only
// what was never charged.
//
// Skipped unless RUN_DB_INTEGRATION=1 and TEST_DATABASE_URL are set. The fixture
// lives in ./support/db-harness.ts.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Client } from "pg";
import { connectHarness, dbSuite, type Harness } from "./support/db-harness";

let harness: Harness;
/** ai_jobs_module_shape_check wants a real active style behind module = 'style'. */
let fixtureStyleId: string;

dbSuite("runtime concurrency (database)", () => {
  beforeAll(async () => {
    harness = await connectHarness();
    fixtureStyleId = (await harness.createStyle("Concurrency fixture", { references: 1 })).styleId;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  type Fixture = {
    createdAt: string;
    workspaceId?: string;
    styleId?: string;
    withReservation?: boolean;
    status?: string;
    attemptCount?: number;
    leaseOwner?: string;
    leaseExpiresAt?: Date;
  };

  /**
   * A fixture job at the front of the claim order. claim_ai_jobs picks the oldest
   * queued row across the whole table (order by created_at, id), so a 1970 stamp
   * keeps every race on the fixture even when a user has a real job queued. The
   * input is deliberately incomplete: if the five-second production worker wins the
   * race, AiJobSchema rejects the row before any provider call.
   */
  const insertJob = async (fixture: Fixture, id = crypto.randomUUID()) => {
    await harness.admin.query(
      `insert into public.ai_jobs(id, workspace_id, module, requested_by, operation, provider, model, status, attempt_count, input, created_at, lease_owner, lease_expires_at, style_id)
       values($1,$2,'style',$3,'text_to_image','openai','openai/gpt-image-2',$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [
        id,
        fixture.workspaceId ?? harness.workspaceId,
        harness.userId,
        fixture.status ?? "queued",
        fixture.attemptCount ?? 0,
        JSON.stringify({ prompt: "race", count: 1, style_id: fixture.styleId ?? fixtureStyleId }),
        fixture.createdAt,
        fixture.leaseOwner ?? null,
        fixture.leaseExpiresAt?.toISOString() ?? null,
        fixture.styleId ?? fixtureStyleId,
      ],
    );
    harness.track("job", id);
    return id;
  };

  /**
   * Inserts the fixture and claims it inside one transaction: the production worker
   * cannot see the row before the claim owns it, so the lease is always the one
   * asked for. A claim may only carry a chargeable reservation when the provider is
   * going to start.
   */
  const insertAndClaim = async (fixture: Fixture, worker: string) => {
    const jobId = crypto.randomUUID();
    await harness.admin.query("begin");
    try {
      await harness.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await insertJob(fixture, jobId);
      if (fixture.withReservation) {
        const reservation = (await harness.admin.query("select public.reserve_ai_quota_internal($1,'image',1) as id", [fixture.workspaceId ?? harness.workspaceId])).rows[0].id as string;
        await harness.admin.query("select public.attach_ai_quota_reservation_internal($1,$2)", [jobId, reservation]);
      }
      const claimed = await harness.admin.query("select id::text as id from public.claim_ai_jobs($1, 1, 120)", [worker]);
      await harness.admin.query("commit");
      return { jobId, claimed: claimed.rows.map((row) => row.id as string) };
    } catch (error) {
      await harness.admin.query("rollback").catch(() => undefined);
      throw error;
    }
  };

  /** Claims on a session of the caller's own, which is what makes the race a race. */
  const claimOn = async (session: Client, worker: string) => {
    await session.query("begin");
    await session.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    const claimed = await session.query("select id::text as id from public.claim_ai_jobs($1, 1, 120)", [worker]);
    await session.query("commit");
    return claimed.rows.map((row) => row.id as string);
  };

  it("two sessions that claim at the same time leave exactly one winner", { timeout: 60_000 }, async () => {
    const { admin } = harness;
    const a = await harness.newSession();
    const b = await harness.newSession();
    try {
      // Two real sessions are the precondition, not the test.
      const [pidA, pidB] = await Promise.all([a.query("select pg_backend_pid() as pid"), b.query("select pg_backend_pid() as pid")]);
      expect(pidA.rows[0].pid).not.toBe(pidB.rows[0].pid);

      // This fixture must be committed before the race, so the production worker can
      // see it too. When it wins, the race is retried on a fresh fixture instead of
      // asserting on a row someone else already leased.
      for (let attempt = 1; ; attempt += 1) {
        const jobId = await insertJob({ createdAt: "1970-01-01T00:00:00+00" });
        const [claimedA, claimedB] = await Promise.all([claimOn(a, "race-a"), claimOn(b, "race-b")]);
        const row = (await admin.query("select status, attempt_count, lease_owner, lease_expires_at > now() as live from public.ai_jobs where id = $1", [jobId])).rows[0];
        const stolen = !claimedA.includes(jobId) && !claimedB.includes(jobId) && row.lease_owner !== null;
        if (stolen && attempt < 3) continue;
        expect(stolen, "the production worker claimed the fixture on every attempt").toBe(false);

        expect([claimedA, claimedB].filter((ids) => ids.length === 1)).toHaveLength(1);
        expect([...claimedA, ...claimedB]).toEqual([jobId]);
        expect(row).toMatchObject({ status: "submitting", attempt_count: 1, live: true });
        expect(row.lease_owner).toBe(claimedA.length === 1 ? "race-a" : "race-b");
        break;
      }
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it("only the owner may renew or start a claim", { timeout: 60_000 }, async () => {
    const { admin } = harness;
    // A workspace of its own: starting the provider charges quota, and charged is
    // never refunded, so the shared workspace's counter would grow with every run.
    const scope = await harness.createWorkspace("Concurrency lease");
    const style = await harness.createStyle("Lease fixture", { references: 1, workspaceId: scope.workspaceId });
    const { jobId } = await insertAndClaim({ createdAt: "1970-01-01T00:00:01+00", withReservation: true, workspaceId: scope.workspaceId, styleId: style.styleId }, "lease-a");
    expect((await admin.query("select status, lease_owner from public.ai_jobs where id = $1", [jobId])).rows[0]).toMatchObject({ status: "submitting", lease_owner: "lease-a" });

    await expect(harness.asService("select public.renew_ai_job_lease($1, 'lease-b', 120)", [jobId])).rejects.toThrow(/LEASE_NOT_OWNED/);
    await expect(harness.asService("select public.begin_ai_job_provider($1, 'lease-b')", [jobId])).rejects.toThrow(/LEASE_NOT_OWNED/);
    await harness.asService("select public.renew_ai_job_lease($1, 'lease-a', 120)", [jobId], { commit: true });
    await harness.asService("select * from public.begin_ai_job_provider($1, 'lease-a')", [jobId], { commit: true });

    const row = (await admin.query("select status, provider_started_at, lease_owner from public.ai_jobs where id = $1", [jobId])).rows[0];
    expect(row).toMatchObject({ status: "processing", lease_owner: "lease-a" });
    expect(row.provider_started_at).not.toBeNull();
  });

  it("a claimed job is never claimed twice", { timeout: 60_000 }, async () => {
    const { admin } = harness;
    const { jobId, claimed } = await insertAndClaim({ createdAt: "1970-01-01T00:00:02+00" }, "race-c");
    expect(claimed).toEqual([jobId]);

    const second = await harness.asService<{ id: string }>("select id from public.claim_ai_jobs($1, 1, 120)", ["race-d"], { commit: true });
    expect(second.map((row) => row.id)).not.toContain(jobId);
    // With the fixture leased, the second claim's only other candidate is a real
    // queued job. Hand it straight back rather than let a test hold its lease.
    const borrowed = second.map((row) => row.id);
    if (borrowed.length > 0) {
      await admin.query("update public.ai_jobs set status='queued', attempt_count=0, lease_owner=null, lease_expires_at=null, updated_at=now() where id = any($1::uuid[])", [borrowed]);
    }

    const row = (await admin.query("select status, attempt_count, lease_owner from public.ai_jobs where id = $1", [jobId])).rows[0];
    expect(row).toMatchObject({ status: "submitting", attempt_count: 1, lease_owner: "race-c" });
  });

  it("an expired lease fails the job and returns only what was never charged", { timeout: 60_000 }, async () => {
    const { admin } = harness;
    // A workspace of its own: test files run in parallel and the borrowed
    // workspace's usage row is shared, so only a private one is deterministic.
    const scope = await harness.createWorkspace("Concurrency expiry");
    const style = await harness.createStyle("Expiry fixture", { references: 1, workspaceId: scope.workspaceId });
    const before = await harness.usage(scope.workspaceId);
    const fixture = { createdAt: "1970-01-01T00:00:10+00", workspaceId: scope.workspaceId, styleId: style.styleId };
    // Built directly, not claimed: the test owns the lease state it expires. A lease
    // in the future keeps the production sweeper off both rows until the last step.
    const reserved = await insertJob({ ...fixture, status: "submitting", attemptCount: 1, leaseOwner: "expiry-a", leaseExpiresAt: new Date(Date.now() + 120_000) });
    const reservationA = (await admin.query("select public.reserve_ai_quota_internal($1,'image',1) as id", [scope.workspaceId])).rows[0].id as string;
    await admin.query("select public.attach_ai_quota_reservation_internal($1,$2)", [reserved, reservationA]);
    const processing = await insertJob({ ...fixture, createdAt: "1970-01-01T00:00:11+00", status: "submitting", attemptCount: 1, leaseOwner: "expiry-b", leaseExpiresAt: new Date(Date.now() + 120_000) });
    const reservationB = (await admin.query("select public.reserve_ai_quota_internal($1,'image',1) as id", [scope.workspaceId])).rows[0].id as string;
    await admin.query("select public.attach_ai_quota_reservation_internal($1,$2)", [processing, reservationB]);
    await harness.asService("select * from public.begin_ai_job_provider($1, 'expiry-b')", [processing], { commit: true });
    // Only now are both leases moved into the past, so nothing can expire them early.
    await admin.query("update public.ai_jobs set lease_expires_at = now() - interval '1 minute' where id = any($1::uuid[])", [[reserved, processing]]);

    await harness.asService("select * from public.expire_stale_ai_jobs(10)", [], { commit: true });

    const rows = (await admin.query("select id, status, error_code, lease_owner, lease_expires_at, completed_at from public.ai_jobs where id = any($1::uuid[]) order by id", [[reserved, processing]])).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "failed", error_code: "PROVIDER_OUTCOME_UNKNOWN", lease_owner: null, lease_expires_at: null });
      expect(row.completed_at).not.toBeNull();
    }
    expect((await admin.query("select state from public.ai_quota_reservations where id = $1", [reservationA])).rows[0].state).toBe("released");
    expect((await admin.query("select state from public.ai_quota_reservations where id = $1", [reservationB])).rows[0].state).toBe("charged");
    const after = await harness.usage(scope.workspaceId);
    expect(after.held).toBe(before.held);
    // Only B's provider start charges; the expiry itself refunds and charges nothing.
    expect(after.charged).toBe(before.charged + 1);
  });
});
