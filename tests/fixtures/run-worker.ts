#!/usr/bin/env tsx
/**
 * Fixture: drive the real private AI-worker route against a live (local Supabase) DB.
 *
 * This fixture waits for the staging run job to appear and terminalize.
 * If NEXT_PUBLIC_APP_URL is set, it also POSTs the real worker endpoint
 * to prove the claim/lease/persist transport runs on a real DB with no
 * paid provider call.
 *
 * Exit 0 = job reached terminal (succeeded/failed/canceled).
 * Exit 1 = ERR / deadline exceeded / env missing.
 */
import { createClient } from "@supabase/supabase-js";

const appUrl = process.env.NEXT_PUBLIC_APP_URL;
const workerSecret = process.env.AI_WORKER_SECRET;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const runId = process.env.STAGING_RUN_ID;
const workspaceId = process.env.STAGING_WORKSPACE_ID;

for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STAGING_WORKSPACE_ID", "STAGING_RUN_ID"]) {
  if (!process.env[key]) throw new Error(`missing ${key}`);
}

const client = createClient(supabaseUrl!, serviceKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const deadline = Date.now() + 120_000;

// If the real worker endpoint is available, POST it to kick the claim loop.
if (appUrl && workerSecret) {
  try {
    const res = await fetch(`${appUrl}/api/internal/ai-worker`, {
      method: "POST",
      headers: { Authorization: `Bearer ${workerSecret}` },
    });
    const body = await res.json().catch(() => ({}));
    console.log(`worker POST → ${res.status} ${JSON.stringify(body)}`);
  } catch (err) {
    console.error(`WARN: worker POST failed (non-fatal): ${err}`);
  }
}

// Poll until the staging job reaches a terminal status or deadline.
let seenTerminal: string | null = null;
while (Date.now() < deadline) {
  const { data, error } = await client
    .from("ai_jobs")
    .select("id, status, error_code")
    .eq("workspace_id", workspaceId!)
    .contains("input", { staging_run_id: runId! })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const job = data?.[0];
  if (job && ["failed", "succeeded", "canceled"].includes(job.status)) {
    seenTerminal = job.status;
    console.log(`job ${job.id} terminal: ${job.status} (error_code=${job.error_code ?? "none"})`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

if (!seenTerminal) {
  console.error("ERR: target job never reached a terminal state within deadline");
  process.exit(1);
}

console.log("READY");
