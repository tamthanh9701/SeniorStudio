import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { AiJobSchema } from "@/db/ai-jobs";
import { getJobResultUrls } from "@/lib/ai/job-results";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data: job } = await supabase.from("ai_jobs").select("*").eq("id", jobId).single();
  const parsed = AiJobSchema.safeParse(job);
  if (!parsed.success) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  return NextResponse.json({ job: parsed.data, result_urls: await getJobResultUrls(supabase, parsed.data) });
}
