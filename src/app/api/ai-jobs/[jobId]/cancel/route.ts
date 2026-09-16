import { NextResponse } from "next/server";
import { createClient, getServiceClient } from "@/supabase/server";
import { STORAGE_BUCKET } from "@/db/schema";
export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data: existing } = await supabase.from("ai_jobs").select("*").eq("id", jobId).single();
  if (!existing) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });

  // Queued-only cancel via DB RPC — no provider cancel. The error object is read
  // directly: PostgREST reports failures as a plain object, so `instanceof Error`
  // mapped every refusal to 409, including a job that does not exist.
  let job: unknown;
  try {
    const { data, error } = await supabase.rpc("cancel_ai_job", { p_job_id: jobId });
    if (error) {
      const message = error.message || "JOB_NOT_CANCELABLE";
      const code = message.includes("NOT_FOUND") ? "NOT_FOUND" : "JOB_NOT_CANCELABLE";
      return NextResponse.json({ error: { code, message } }, { status: code === "NOT_FOUND" ? 404 : 409 });
    }
    job = data;
  } catch (transportError) {
    const message = transportError instanceof Error ? transportError.message : String(transportError);
    console.error(`cancel call failed job=${jobId}: ${message}`);
    return NextResponse.json({ error: { code: "CANCEL_FAILED", message } }, { status: 500 });
  }

  // The cancellation has committed: cleaning up the uploaded mask is best-effort
  // and can never turn a canceled job into a failed request.
  if (existing.input?.mask_storage_path) {
    try {
      const service = getServiceClient();
      const { error: removeError } = await service.storage.from(STORAGE_BUCKET).remove([existing.input.mask_storage_path]);
      if (removeError) console.error(`cancel mask removal failed job=${jobId}: ${removeError.message}`);
      const { error: inputError } = await service.from("ai_job_inputs").delete().eq("storage_path", existing.input.mask_storage_path);
      if (inputError) console.error(`cancel mask row delete failed job=${jobId}: ${inputError.message}`);
    } catch (cleanupError) {
      console.error(`cancel mask cleanup threw job=${jobId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
  return NextResponse.json({ job });
}
