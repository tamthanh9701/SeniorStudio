import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { CreateBatchRunInputSchema } from "@/db/batch";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = CreateBatchRunInputSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  }

  const { project_id, preset_id, items, concurrency } = result.data;

  // Get workspace ID
  const { data: member } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // Create batch run
  const { data: batchRun, error: runError } = await supabase
    .from("batch_runs")
    .insert({
      workspace_id: member.workspace_id,
      project_id,
      preset_id: preset_id || null,
      status: "pending",
    })
    .select()
    .single();

  if (runError) {
    return NextResponse.json({ error: runError.message }, { status: 500 });
  }

  // Create batch items
  const { data: batchItems, error: itemsError } = await supabase
    .from("batch_items")
    .insert(
      items.map((item) => ({
        batch_run_id: batchRun.id,
        asset_id: item.asset_id,
        parent_version_id: item.parent_version_id || null,
        status: "pending",
      }))
    )
    .select();

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }

  // Start processing in background (simplified - in production use a queue)
  processBatchRun(batchRun.id, concurrency).catch(console.error);

  return NextResponse.json({ batch_run: batchRun, items: batchItems });
}

async function processBatchRun(batchRunId: string, concurrency: number) {
  const supabase = createServiceClient();
  
  // Update status to running
  await supabase
    .from("batch_runs")
    .update({ status: "running" })
    .eq("id", batchRunId);

  // Get pending items
  const { data: items } = await supabase
    .from("batch_items")
    .select("*")
    .eq("batch_run_id", batchRunId)
    .eq("status", "pending")
    .order("created_at");

  if (!items || items.length === 0) {
    await supabase
      .from("batch_runs")
      .update({ status: "succeeded", completed_at: new Date().toISOString() })
      .eq("id", batchRunId);
    return;
  }

  // Process items with concurrency limit
  const queue = [...items];
  const active: Promise<void>[] = [];

  const processItem = async (item: typeof items[0]) => {
    try {
      // Update item status
      await supabase
        .from("batch_items")
        .update({ status: "running" })
        .eq("id", item.id);

      // In production, this would call the generate/edit API
      // For now, just mark as succeeded
      await supabase
        .from("batch_items")
        .update({ status: "succeeded" })
        .eq("id", item.id);
    } catch (error) {
      await supabase
        .from("batch_items")
        .update({
          status: "failed",
          error_code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        })
        .eq("id", item.id);
    }
  };

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      const promise = processItem(item).then(() => {
        active.splice(active.indexOf(promise), 1);
      });
      active.push(promise);
    }

    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  // Check final status
  const { data: finalItems } = await supabase
    .from("batch_items")
    .select("status")
    .eq("batch_run_id", batchRunId);

  const allSucceeded = finalItems?.every((i: { status: string }) => i.status === "succeeded");
  const anyFailed = finalItems?.some((i: { status: string }) => i.status === "failed");

  await supabase
    .from("batch_runs")
    .update({
      status: allSucceeded ? "succeeded" : anyFailed ? "partial" : "succeeded",
      completed_at: new Date().toISOString(),
    })
    .eq("id", batchRunId);
}

function createServiceClient() {
  const { createClient } = require("@supabase/supabase-js");
  const env = require("@/env").getEnv();
  
  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
