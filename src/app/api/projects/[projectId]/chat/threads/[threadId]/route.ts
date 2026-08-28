import { NextResponse } from "next/server";
import { ACTIVE_JOB_STATUSES } from "@/db/browser-bridge";
import { createClient } from "@/supabase/server";

export async function GET(_: Request, { params }: { params: Promise<{ projectId: string; threadId: string }> }) {
  const { projectId, threadId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const { data: thread } = await supabase.from("chat_threads").select("*")
    .eq("id", threadId).eq("project_id", projectId).maybeSingle();
  if (!thread) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const [{ data: messages, error: messageError }, { data: activeJob, error: jobError }, { data: worker }] = await Promise.all([
    supabase.from("chat_messages").select("*").eq("thread_id", threadId).order("created_at", { ascending: true }).order("id", { ascending: true }),
    supabase.from("browser_jobs").select("*").eq("thread_id", threadId).in("status", ACTIVE_JOB_STATUSES).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("browser_bridge_workers").select("*").order("last_seen_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (messageError || jobError) return NextResponse.json({ error: "LOAD_FAILED" }, { status: 500 });

  const fresh = worker && Date.now() - new Date(worker.last_seen_at).getTime() <= 30_000;
  const bridge = worker ? { ...worker, status: fresh ? worker.status : "offline" } : {
    worker_id: "unavailable", status: "offline", last_seen_at: null, active_job_id: null,
    browser_url: null, error_code: null, error_message: null,
  };
  return NextResponse.json({ thread, messages: messages ?? [], active_job: activeJob ?? null, bridge });
}
