import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";

export async function POST(_: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const { data, error } = await supabase.rpc("retry_browser_job", { p_job_id: jobId });
  if (!error) return NextResponse.json({ job: data });
  const code = ["THREAD_BUSY", "NOT_FOUND", "INVALID_STATE"].find((candidate) => error.message.includes(candidate)) ?? "RETRY_FAILED";
  return NextResponse.json({ error: code }, { status: code === "NOT_FOUND" ? 404 : code === "RETRY_FAILED" ? 500 : 409 });
}
