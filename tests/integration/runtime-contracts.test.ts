// @vitest-environment node
// The runtime contract, proven against the database the app talks to: which RPC
// signatures, policies and constraints exist, and what the quota, lease and
// persistence lifecycle does to real job rows. Replaces the pgTAP script, which
// could only assert that four objects existed.
//
// Skipped unless RUN_DB_INTEGRATION=1 and TEST_DATABASE_URL are set. The fixture
// lives in ./support/db-harness.ts.
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectHarness, dbSuite, type Harness } from "./support/db-harness";

let harness: Harness;

dbSuite("runtime contracts (database)", () => {
  beforeAll(async () => {
    harness = await connectHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  const usage = (workspaceId: string) => harness.usage(workspaceId);

  /** A queued fixture the production worker cannot claim (claim requires attempt_count = 0). */
  const guardFromClaim = async (jobId: string) => {
    await harness.admin.query("update public.ai_jobs set attempt_count = 1 where id = $1", [jobId]);
  };

  it("the RPCs, policies and constraints the runtime calls are the ones the migrations define", { timeout: 30_000 }, async () => {
    const { admin } = harness;
    const signatures = (
      await admin.query(
        `select p.oid::regprocedure::text as signature
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'`,
      )
    ).rows.map((row) => row.signature as string);
    for (const expected of [
      "enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid)",
      "cancel_ai_job(uuid)",
      "begin_ai_job_provider(uuid,text)",
      "fail_ai_job(uuid,text,text,text)",
      "expire_stale_ai_jobs(integer)",
      "complete_ai_job_with_results(uuid,text,text,text,jsonb,jsonb)",
      "resolve_ai_job_persistence(uuid,text,uuid[])",
    ]) {
      expect(signatures, `missing ${expected}`).toContain(expected);
    }

    const policies = (
      await admin.query(
        `select tablename, policyname from pg_policies
          where schemaname = 'public' and tablename in ('ai_jobs','workspace_ai_usage','ai_quota_reservations')`,
      )
    ).rows.map((row) => `${row.tablename}.${row.policyname}`);
    for (const expected of ["ai_jobs.Owners can read ai jobs", "workspace_ai_usage.workspace usage read", "ai_quota_reservations.workspace reservation read"]) {
      expect(policies, `missing ${expected}`).toContain(expected);
    }

    const checks = (
      await admin.query("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.ai_quota_reservations'::regclass and contype = 'c'")
    ).rows.map((row) => row.def as string).join(" ");
    for (const state of ["reserved", "charged", "released"]) expect(checks, `reservation state ${state}`).toContain(state);
  });

  it("a canceled job gives its held quota back", { timeout: 30_000 }, async () => {
    // A workspace of its own: test files run in parallel and the borrowed
    // workspace's usage row is shared, so only a private one is deterministic.
    const scope = await harness.createWorkspace("Contracts cancel");
    const style = await harness.createStyle("Contracts cancel", { references: 1, workspaceId: scope.workspaceId });
    const heldBefore = (await usage(scope.workspaceId)).held;
    const job = await harness.enqueueStyleJob(harness.packet(style.styleId, style.revision, style.references), style.styleId, { commit: true, as: scope.userId });
    await guardFromClaim(job.id);
    expect((await usage(scope.workspaceId)).held).toBe(heldBefore + 1);

    const canceled = await harness.asMember<{ status: string }>("select (public.cancel_ai_job($1)).status as status", [job.id], { commit: true, as: scope.userId });
    expect(canceled[0].status).toBe("canceled");

    const reservation = (await harness.admin.query("select state from public.ai_quota_reservations where job_id = $1", [job.id])).rows[0];
    expect(reservation.state).toBe("released");
    expect((await usage(scope.workspaceId)).held).toBe(heldBefore);
  });

  it("a job that reached the provider is charged, never refunded", { timeout: 30_000 }, async () => {
    const { admin } = harness;
    const scope = await harness.createWorkspace("Contracts provider");
    // Built directly rather than through claim_ai_jobs: the claim orders by
    // created_at across the whole table, so a borrowed queued row would win.
    // ai_jobs_module_shape_check wants a real active style behind module = 'style'.
    const style = await harness.createStyle("Contracts provider", { references: 1, workspaceId: scope.workspaceId });
    const jobId = crypto.randomUUID();
    await admin.query(
      `insert into public.ai_jobs(id, workspace_id, module, requested_by, operation, provider, model, status, attempt_count, lease_owner, lease_expires_at, input, style_id)
       values($1,$2,'style',$3,'text_to_image','openai','openai/gpt-image-2','submitting',1,'plan-worker', now() + interval '2 minutes', $4::jsonb, $5)`,
      [jobId, scope.workspaceId, scope.userId, JSON.stringify({ prompt: "contracts", count: 1, style_id: style.styleId }), style.styleId],
    );
    harness.track("job", jobId);
    // The baseline is the usage row before the reservation, so a successful charge
    // is exactly "held back to where it was, charged one higher".
    const { held: heldBefore, charged: chargedBefore } = await usage(scope.workspaceId);
    const reservation = (await admin.query("select public.reserve_ai_quota_internal($1,'image',1) as id", [scope.workspaceId])).rows[0].id as string;
    await admin.query("select public.attach_ai_quota_reservation_internal($1,$2)", [jobId, reservation]);

    await harness.asService("select * from public.begin_ai_job_provider($1, 'plan-worker')", [jobId], { commit: true });
    expect((await admin.query("select state from public.ai_quota_reservations where id = $1", [reservation])).rows[0].state).toBe("charged");
    const charged = await usage(scope.workspaceId);
    expect(charged.held).toBe(heldBefore);
    expect(charged.charged).toBe(chargedBefore + 1);
    const processing = (await admin.query("select status, provider_started_at from public.ai_jobs where id = $1", [jobId])).rows[0];
    expect(processing.status).toBe("processing");
    expect(processing.provider_started_at).not.toBeNull();

    await harness.asService("select public.fail_ai_job($1, 'plan-worker', 'PROVIDER_ERROR', 'x')", [jobId], { commit: true });
    expect((await admin.query("select state from public.ai_quota_reservations where id = $1", [reservation])).rows[0].state).toBe("charged");
    expect((await usage(scope.workspaceId)).charged).toBe(chargedBefore + 1);
  });

  it("the cap refuses the next job without leaking the reservation", { timeout: 30_000 }, async () => {
    const { admin } = harness;
    const cap = await harness.createWorkspace("Contracts cap");
    await admin.query(
      "insert into public.workspace_ai_limits(workspace_id, image_limit, brain_limit) values($1, 1, 200) on conflict (workspace_id) do update set image_limit = 1",
      [cap.workspaceId],
    );
    const style = await harness.createStyle("Contracts cap", { workspaceId: cap.workspaceId });
    const packet = harness.packet(style.styleId, style.revision, style.references);

    const job = await harness.enqueueStyleJob(packet, style.styleId, { commit: true, as: cap.userId });
    await guardFromClaim(job.id);
    expect((await usage(cap.workspaceId)).held).toBe(1);

    await expect(harness.enqueueStyleJob(packet, style.styleId, { commit: true, as: cap.userId })).rejects.toThrow(/quota_exceeded/);
    expect((await usage(cap.workspaceId)).held).toBe(1);
    const reservations = (await admin.query("select state from public.ai_quota_reservations where workspace_id = $1", [cap.workspaceId])).rows;
    expect(reservations).toHaveLength(1);
    expect(reservations[0].state).toBe("reserved");
  });

  it("resolve_ai_job_persistence answers committed, aborted and unknown", { timeout: 30_000 }, async () => {
    const { admin, workspaceId, userId } = harness;
    const style = await harness.createStyle("Contracts persistence", { references: 1 });
    const insertJob = async (status: string, input: unknown, output: unknown, leaseOwner: string | null) => {
      const id = crypto.randomUUID();
      await admin.query(
        `insert into public.ai_jobs(id, workspace_id, module, requested_by, operation, provider, model, status, input, output, lease_owner, style_id)
         values($1,$2,'style',$3,'text_to_image','openai','openai/gpt-image-2',$4,$5::jsonb,$6::jsonb,$7,$8)`,
        [id, workspaceId, userId, status, JSON.stringify({ ...(input as Record<string, unknown>), style_id: style.styleId }), JSON.stringify(output), leaseOwner, style.styleId],
      );
      harness.track("job", id);
      return id;
    };
    const versionId = crypto.randomUUID();
    const committedJob = await insertJob("succeeded", { prompt: "contracts", count: 1 }, { results: [{ version_id: versionId }] }, null);
    const committed = await harness.asService<{ result: { state: string; job?: { id: string } } }>(
      "select public.resolve_ai_job_persistence($1,$2,$3::uuid[]) as result",
      [committedJob, "plan-worker", [versionId]],
      { commit: true },
    );
    expect(committed[0].result.state).toBe("committed");
    expect(committed[0].result.job?.id).toBe(committedJob);

    const abortedJob = await insertJob("processing", { prompt: "contracts", count: 1 }, {}, "plan-worker");
    const aborted = await harness.asService<{ result: { state: string } }>(
      "select public.resolve_ai_job_persistence($1,$2,$3::uuid[]) as result",
      [abortedJob, "plan-worker", []],
      { commit: true },
    );
    expect(aborted[0].result.state).toBe("aborted");
    const failed = (await admin.query("select status, error_code from public.ai_jobs where id = $1", [abortedJob])).rows[0];
    expect(failed).toMatchObject({ status: "failed", error_code: "PERSISTENCE_FAILED" });

    const unknown = await harness.asService<{ result: { state: string } }>(
      "select public.resolve_ai_job_persistence($1,$2,$3::uuid[]) as result",
      [crypto.randomUUID(), "plan-worker", []],
      { commit: true },
    );
    expect(unknown[0].result.state).toBe("unknown");
  });
});
