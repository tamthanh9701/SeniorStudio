// Inpaint masks and the objects kept after an unreadable persistence outcome are
// cleaned up from here: this route already runs on a short schedule with the
// service role, and both sweeps are bounded so a run stays cheap.
import { NextResponse } from "next/server";
import { STORAGE_BUCKET } from "@/db/schema";
import { getEnv } from "@/env";
import { getServiceClient } from "@/supabase/server";
import { LEASE_SECONDS, processAiJob, type WorkerOutcome } from "@/lib/ai/worker";

const MASK_SWEEP_LIMIT = 100;
/** Long enough that an in-flight worker can still finish (its lease is 180 s). */
const RECONCILE_AFTER_MS = 15 * 60 * 1000;
const RECONCILE_LIMIT = 20;

async function sweepExpiredMasks(client: ReturnType<typeof getServiceClient>): Promise<{ removed: number; storageFailed: number }> {
  const { data: masks, error } = await client.rpc("claim_expired_job_masks", { p_limit: MASK_SWEEP_LIMIT });
  if (error) {
    console.error(`mask sweep failed: ${error.message}`);
    return { removed: 0, storageFailed: 0 };
  }
  const rows = (masks ?? []) as Array<{ storage_path: string; cause: string }>;
  if (rows.length === 0) return { removed: 0, storageFailed: 0 };
  let storageFailed = 0;
  // The rows are already gone; a failure here only leaves an orphaned object,
  // which is logged for an operator rather than retried inside the cron.
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100).map((row) => row.storage_path);
    const { error: removeError } = await client.storage.from(STORAGE_BUCKET).remove(chunk);
    if (removeError) {
      storageFailed += chunk.length;
      console.error(`mask sweep object removal failed: ${removeError.message}`);
    }
  }
  return { removed: rows.length, storageFailed };
}

/**
 * Uploads are kept when the persistence outcome cannot be read, because deleting
 * them could throw away a result that was already paid for. Once the job is past
 * any possible in-flight state, keep the objects of a committed job and remove
 * the rest, so nothing lingers unreferenced.
 */
async function reconcilePendingUploads(client: ReturnType<typeof getServiceClient>): Promise<{ kept: number; removed: number; failed: number }> {
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
  const { data: jobs, error } = await client
    .from("ai_jobs")
    .select("id, status, version_id, output")
    .not("output->pending_uploads", "is", null)
    .lt("updated_at", cutoff)
    .limit(RECONCILE_LIMIT);
  if (error) {
    console.error(`pending upload lookup failed: ${error.message}`);
    return { kept: 0, removed: 0, failed: 0 };
  }
  let kept = 0;
  let removed = 0;
  let failed = 0;
  for (const job of jobs ?? []) {
    const output = (job.output ?? {}) as { pending_uploads?: unknown };
    const paths = Array.isArray(output.pending_uploads) ? output.pending_uploads.filter((path): path is string => typeof path === "string") : [];
    const committed = job.status === "succeeded" && typeof job.version_id === "string";
    if (!committed && paths.length > 0) {
      const { error: removeError } = await client.storage.from(STORAGE_BUCKET).remove(paths);
      if (removeError) {
        failed += 1;
        console.error(`pending upload removal failed job=${job.id}: ${removeError.message}`);
        continue;
      }
      removed += paths.length;
    } else if (committed) {
      kept += paths.length;
    }
    const { error: clearError } = await client.rpc("clear_pending_uploads", { p_job_id: job.id });
    if (clearError) console.error(`pending upload marker clear failed job=${job.id}: ${clearError.message}`);
  }
  return { kept, removed, failed };
}

export const maxDuration = 300;

export async function POST(request: Request) {
  const expected = `Bearer ${getEnv().AI_WORKER_SECRET}`;
  if (request.headers.get("authorization") !== expected) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const client = getServiceClient();
  const workerId = `vercel-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const { data: expired, error: expireError } = await client.rpc("expire_stale_ai_jobs", { p_limit: 20 });
  if (expireError) return NextResponse.json({ error: expireError.message }, { status: 500 });
  const { data: jobs, error } = await client.rpc("claim_ai_jobs", { p_worker_id: workerId, p_limit: 3, p_lease_seconds: LEASE_SECONDS });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await client.from("service_heartbeats").upsert(
    { service: "ai_worker", last_seen_at: new Date().toISOString() },
    { onConflict: "service" }
  );
  const results = await Promise.allSettled((jobs ?? []).map((job: unknown) => processAiJob(client, job, workerId)));
  const counts: Record<WorkerOutcome, number> = { succeeded: 0, processing: 0, failed: 0, canceled: 0, lease_lost: 0 };
  let hasRejection = false;
  for (const result of results) {
    if (result.status === "fulfilled") {
      const outcome: WorkerOutcome = result.value;
      counts[outcome] += 1;
    } else {
      counts.failed += 1;
      hasRejection = true;
    }
  }
  const masks = await sweepExpiredMasks(client);
  const uploads = await reconcilePendingUploads(client);
  console.log(
    `ai_worker_invocation claimed=${jobs?.length ?? 0} expired=${expired?.length ?? 0} ` +
      `masks_removed=${masks.removed} masks_storage_failed=${masks.storageFailed} ` +
      `uploads_kept=${uploads.kept} uploads_removed=${uploads.removed} uploads_failed=${uploads.failed} elapsed_ms=${Date.now() - startedAt}`,
  );
  if (hasRejection) {
    return NextResponse.json({ error: "One or more jobs failed" }, { status: 500 });
  }
  return NextResponse.json({ expired: expired?.length ?? 0, claimed: jobs?.length ?? 0, masks, uploads, ...counts });
}
