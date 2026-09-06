import { NextResponse } from "next/server";
import { InpaintEnqueueSchema, providerForModel } from "@/db/ai-jobs";
import { assertModelSupports } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getEnv } from "@/env";
import { getProviderApiKey } from "@/lib/ai/credentials";

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = InpaintEnqueueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    const model = await assertModelSupports(parsed.data.model, "inpaint");
    if (!(await getProviderApiKey(model.provider, { user: supabase, service: getServiceClient() }))) throw new Error("PROVIDER_NOT_CONFIGURED");
    if (!model.qualities.includes(parsed.data.quality as never)) throw new Error("INVALID_MODEL");
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
    if (!member) throw new Error("NOT_FOUND");
    const service = getServiceClient();
    const { data: input } = await service.from("ai_job_inputs").select("*").eq("id", parsed.data.maskId).eq("workspace_id", member.workspace_id).eq("asset_id", assetId).eq("parent_version_id", parsed.data.parentVersionId).gt("expires_at", new Date().toISOString()).is("job_id", null).single();
    if (!input) throw new Error("NOT_FOUND");
    const { data: job, error } = await supabase.rpc("enqueue_ai_job", {
      p_workspace_id: member.workspace_id, p_project_id: input.project_id, p_requested_by: user.id,
      p_operation: parsed.data.operation, p_provider: providerForModel(parsed.data.model), p_model: parsed.data.model,
      p_prompt: parsed.data.prompt, p_count: 1, p_size: "auto", p_quality: parsed.data.quality,
      p_asset_id: assetId, p_parent_version_id: parsed.data.parentVersionId, p_mask_storage_path: input.storage_path,
    });
    if (error) throw error;
    const { error: bindError } = await service.from("ai_job_inputs").update({ job_id: job.id }).eq("id", input.id).is("job_id", null);
    if (bindError) {
      await service.from("ai_jobs").delete().eq("id", job.id);
      throw bindError;
    }
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_REQUEST";
    const code = ["NOT_FOUND", "VERSION_CONFLICT", "INVALID_MODEL", "PROVIDER_NOT_CONFIGURED"].find((candidate) => message.includes(candidate)) ?? "INVALID_REQUEST";
    const status = code === "NOT_FOUND" ? 404 : code === "VERSION_CONFLICT" ? 409 : code === "PROVIDER_NOT_CONFIGURED" ? 503 : 400;
    return NextResponse.json({ error: { code, message } }, { status });
  }
}
