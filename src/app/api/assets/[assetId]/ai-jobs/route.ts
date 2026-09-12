import { NextResponse } from "next/server";
import { InpaintEnqueueSchema, providerForModel } from "@/db/ai-jobs";
import { assertModelSupports } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getProviderApiKey } from "@/lib/ai/credentials";
import { resolveStyleGenerationPlan } from "@/lib/style/generation-plan";

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = InpaintEnqueueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    const { data: asset } = await supabase.from("assets").select("id, style_id, project_id, current_version_id").eq("id", assetId).single();
    if (!asset) throw new Error("NOT_FOUND");
    const member = (await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single()).data;
    if (!member) throw new Error("NOT_FOUND");
    const model = await assertModelSupports(parsed.data.model, "inpaint", supabase, member.workspace_id);
    if (!(await getProviderApiKey(model.provider, { user: supabase, service: getServiceClient(), workspaceId: member.workspace_id }))) throw new Error("PROVIDER_NOT_CONFIGURED");
    if (asset.style_id) {
      if (parsed.data.model !== "openai/gpt-image-2") throw new Error("UNSUPPORTED_SETTINGS");
      const { data: source } = await supabase.from("asset_versions").select("id, prompt, metadata, style_generation").eq("id", parsed.data.parentVersionId).eq("asset_id", assetId).single();
      if (!source) throw new Error("VERSION_CONFLICT");
      const packetResult = await resolveStyleGenerationPlan(supabase, { styleId: asset.style_id, operation: "inpaint", requestedModelId: parsed.data.model, sourceVersionId: parsed.data.parentVersionId, prompt: parsed.data.prompt, referenceIds: parsed.data.referenceIds, editTarget: parsed.data.editTarget, useCurrentStyle: parsed.data.useCurrentStyle, sourcePacket: source.style_generation, maskId: parsed.data.maskId, sourceAssetId: assetId, costMode: "strict_style", count: 1, size: "auto", quality: parsed.data.quality, preserveRequestedModel: true, sourceOriginalPrompt: source.prompt ?? null });
      if (parsed.data.consent?.planHash !== packetResult.plan.planHash) return NextResponse.json({ error: { code: "PLAN_CONSENT_MISMATCH", message: "Execution plan changed; consent must be renewed", plan: packetResult.plan } }, { status: 409 });
      const { data: job, error } = await supabase.rpc("enqueue_style_group_job", { p_style_id: asset.style_id, p_requested_by: user.id, p_operation: "inpaint", p_model: packetResult.plan.effectiveModelId, p_packet: packetResult.packet, p_mask_id: parsed.data.maskId });
      if (error) throw error;
      return NextResponse.json({ job }, { status: 202 });
    }
    if (!asset.project_id) throw new Error("NOT_FOUND");
    if (!model.qualities.includes(parsed.data.quality as never)) throw new Error("INVALID_MODEL");
    const { data: job, error } = await supabase.rpc("enqueue_inpaint_job_v2", { p_mask_id: parsed.data.maskId, p_requested_by: user.id, p_provider: model.provider, p_model: parsed.data.model, p_prompt: parsed.data.prompt, p_quality: parsed.data.quality });
    if (error) throw error;
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_REQUEST";
    const code = ["NOT_FOUND", "VERSION_CONFLICT", "INVALID_MODEL", "PROVIDER_NOT_CONFIGURED", "quota_exceeded", "QUOTA_UNAVAILABLE"].find((candidate) => message.includes(candidate)) ?? "INVALID_REQUEST";
    const status = code === "NOT_FOUND" ? 404 : code === "VERSION_CONFLICT" ? 409 : code === "PROVIDER_NOT_CONFIGURED" ? 503 : code === "quota_exceeded" ? 429 : code === "QUOTA_UNAVAILABLE" ? 503 : 400;
    return NextResponse.json({ error: { code, message } }, { status });
  }
}
