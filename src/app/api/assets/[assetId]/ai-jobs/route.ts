import { NextResponse } from "next/server";
import { InpaintEnqueueSchema, ProjectVariationEnqueueSchema, providerForModel } from "@/db/ai-jobs";
import { assertModelSupports } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getProviderApiKey } from "@/lib/ai/credentials";
import { resolveStyleGenerationPlan } from "@/lib/style/generation-plan";
import { apiErrorFrom } from "@/lib/http/api-errors";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const body = await request.json().catch(() => null);
  // One route, two shapes: an edit carries a mask, a variation carries only a
  // source version. The operation field decides which one was sent.
  const isVariation = typeof body === "object" && body !== null && body.operation === "image_to_image";
  const parsed = (isVariation ? ProjectVariationEnqueueSchema : InpaintEnqueueSchema).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    const { data: asset } = await supabase.from("assets").select("id, style_id, project_id, current_version_id").eq("id", assetId).single();
    if (!asset) throw new Error("NOT_FOUND");
    const member = (await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single()).data;
    if (!member) throw new Error("NOT_FOUND");
    const workspaceId = member.workspace_id;
    if (parsed.data.operation === "image_to_image") {
      // A project variation: the source is a project asset and no style is
      // applied (the style module owns that, with its confirmed definition).
      if (asset.style_id || !asset.project_id) throw new Error("INVALID_REQUEST: a variation needs a project asset");
      const variationModel = await assertModelSupports(parsed.data.model, "image_to_image", getServiceClient(), workspaceId);
      if (!(await getProviderApiKey(variationModel.provider, { service: getServiceClient(), workspaceId }))) throw new Error("PROVIDER_NOT_CONFIGURED");
      if (!variationModel.sizes.includes(parsed.data.size as never) || !variationModel.qualities.includes(parsed.data.quality as never)) throw new Error("INVALID_MODEL");
      if (parsed.data.background === "transparent" && variationModel.supportsTransparentBackground !== true) {
        throw new Error("INVALID_REQUEST: this model cannot return a transparent background");
      }
      const { data: source } = await supabase.from("asset_versions").select("id").eq("id", parsed.data.sourceVersionId).eq("asset_id", assetId).maybeSingle();
      if (!source) throw new Error("VERSION_CONFLICT");
      const { data: job, error } = await supabase.rpc("enqueue_project_image_to_image_job", {
        p_workspace_id: workspaceId, p_requested_by: user.id,
        p_provider: providerForModel(parsed.data.model), p_model: parsed.data.model,
        p_prompt: parsed.data.prompt, p_count: parsed.data.count, p_size: parsed.data.size, p_quality: parsed.data.quality,
        p_source_version_id: parsed.data.sourceVersionId, p_cost_mode: parsed.data.costMode,
        p_background: parsed.data.background ?? null,
      });
      if (error) throw error;
      return NextResponse.json({ job }, { status: 202 });
    }
    if (parsed.data.libraryReferenceIds.length > 0) throw new Error("INVALID_REQUEST: an edit reuses the references of the image it came from");
    const model = await assertModelSupports(parsed.data.model, "inpaint", getServiceClient(), member.workspace_id);
    if (!(await getProviderApiKey(model.provider, { service: getServiceClient(), workspaceId: member.workspace_id }))) throw new Error("PROVIDER_NOT_CONFIGURED");
    if (asset.style_id) {
      if (parsed.data.model !== "openai/gpt-image-2") throw new Error("UNSUPPORTED_SETTINGS");
      const { data: source } = await supabase.from("asset_versions").select("id, prompt, metadata, style_generation").eq("id", parsed.data.parentVersionId).eq("asset_id", assetId).single();
      if (!source) throw new Error("VERSION_CONFLICT");
      const packetResult = await resolveStyleGenerationPlan(supabase, { styleId: asset.style_id, operation: "inpaint", requestedModelId: parsed.data.model, sourceVersionId: parsed.data.parentVersionId, prompt: parsed.data.prompt, referenceIds: parsed.data.referenceIds, editTarget: parsed.data.editTarget, useCurrentStyle: parsed.data.useCurrentStyle, sourcePacket: source.style_generation, maskId: parsed.data.maskId, sourceAssetId: assetId, costMode: "strict_style", count: 1, size: "auto", quality: parsed.data.quality, preserveRequestedModel: true, sourceOriginalPrompt: source.prompt ?? null }, getServiceClient());
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
    const failure = apiErrorFrom(error);
    return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
  }
}
