import { NextResponse } from "next/server";
import { createClient, getServiceClient } from "@/supabase/server";
import { providerForJob } from "@/lib/ai/providers";
import { AiJobSchema } from "@/db/ai-jobs";
import { STORAGE_BUCKET } from "@/db/schema";

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data: existing } = await supabase.from("ai_jobs").select("*").eq("id", jobId).single();
  if (!existing) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  try {
    if (existing.provider === "google" && existing.status === "processing") await (await providerForJob(AiJobSchema.parse(existing))).cancel({ client: getServiceClient(), job: AiJobSchema.parse(existing), apiKey: "" });
    const { data: job, error } = await supabase.rpc("cancel_ai_job", { p_job_id: jobId });
    if (error) throw error;
    if (existing.input?.mask_storage_path) {
      const service = getServiceClient();
      await service.storage.from(STORAGE_BUCKET).remove([existing.input.mask_storage_path]);
      await service.from("ai_job_inputs").delete().eq("storage_path", existing.input.mask_storage_path);
    }
    return NextResponse.json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "JOB_NOT_CANCELABLE";
    const code = message.includes("NOT_FOUND") ? "NOT_FOUND" : "JOB_NOT_CANCELABLE";
    return NextResponse.json({ error: { code, message } }, { status: code === "NOT_FOUND" ? 404 : 409 });
  }
}
