#!/usr/bin/env tsx
import { createClient } from "@supabase/supabase-js";

for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STAGING_WORKSPACE_ID", "STAGING_RUN_ID"]) {
  if (!process.env[key]) throw new Error(`missing ${key}`);
}
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const runId = process.env.STAGING_RUN_ID!;
const workspaceId = process.env.STAGING_WORKSPACE_ID!;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const { data, error } = await client.from("ai_jobs").select("id").eq("workspace_id", workspaceId).contains("input", { staging_run_id: runId }).in("status", ["queued", "submitted"]).limit(1);
  if (error) throw error;
  if (!data?.length) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
