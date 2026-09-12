import { NextResponse } from "next/server";
import { getEnv } from "@/env";
import { getServiceClient } from "@/supabase/server";
import { processAiJob, type WorkerOutcome } from "@/lib/ai/worker";

export async function POST(request: Request) {
  const expected = `Bearer ${getEnv().AI_WORKER_SECRET}`;
  if (request.headers.get("authorization") !== expected) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const client = getServiceClient();
  const workerId = `vercel-${crypto.randomUUID()}`;
  const { data: expired, error: expireError } = await client.rpc("expire_stale_ai_jobs", { p_limit: 20 });
  if (expireError) return NextResponse.json({ error: expireError.message }, { status: 500 });
  const { data: jobs, error } = await client.rpc("claim_ai_jobs", { p_worker_id: workerId, p_limit: 3, p_lease_seconds: 120 });
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
  if (hasRejection) {
    return NextResponse.json({ error: "One or more jobs failed" }, { status: 500 });
  }
  return NextResponse.json({ expired: expired?.length ?? 0, claimed: jobs?.length ?? 0, ...counts });
}
