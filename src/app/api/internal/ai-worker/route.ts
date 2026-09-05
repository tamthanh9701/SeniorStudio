import { NextResponse } from "next/server";
import { getEnv } from "@/env";
import { getServiceClient } from "@/supabase/server";
import { processAiJob, type WorkerOutcome } from "@/lib/ai/worker";

export async function POST(request: Request) {
  const expected = `Bearer ${getEnv().AI_WORKER_SECRET}`;
  if (request.headers.get("authorization") !== expected) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const client = getServiceClient();
  const workerId = `vercel-${crypto.randomUUID()}`;
  const { data: jobs, error } = await client.rpc("claim_ai_jobs", { p_worker_id: workerId, p_limit: 3, p_lease_seconds: 120 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const settled = await Promise.allSettled((jobs ?? []).map((job: unknown) => processAiJob(client, job, workerId)));
  const counts: Record<WorkerOutcome, number> = { succeeded: 0, processing: 0, failed: 0, canceled: 0 };
  for (const result of settled) {
    const outcome: WorkerOutcome = result.status === "fulfilled" ? result.value : "failed";
    counts[outcome] += 1;
  }
  return NextResponse.json({ claimed: jobs?.length ?? 0, ...counts });
}
