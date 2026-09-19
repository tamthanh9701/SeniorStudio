// Reconstruct one element with a provider.  This is a separate, explicitly
// confirmed action: the result is a new image that may differ from the original,
// never a replacement for the screen.
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { resolveGameUiReconstructionPlan } from "@/lib/game-ui/generation-plan";
import { CostModeSchema, SupportedQualitySchema, SupportedSizeSchema } from "@/db/ai-jobs";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const maxDuration = 120;

const ReconstructSchema = z
  .object({
    elementSetId: z.string().uuid(),
    instruction: z.string().trim().min(1).max(2000),
    model: z.string().regex(/^(openai|google)\/[a-z0-9._-]+$/),
    size: SupportedSizeSchema,
    quality: SupportedQualitySchema,
    costMode: CostModeSchema.default("strict_1000"),
    requestId: z.string().uuid(),
    consent: z.object({ planHash: z.string().min(1) }).strict(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ renderId: string; elementId: string }> }) {
  const { renderId, elementId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = ReconstructSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }
  try {
    const render = await requireOwnedRender(supabase, renderId);
    await requireGameUiStyle(supabase, render.style_id);
    const data = parsed.data;
    const result = await resolveGameUiReconstructionPlan(supabase, getServiceClient(), {
      renderId,
      elementSetId: data.elementSetId,
      elementId,
      instruction: data.instruction,
      model: data.model,
      size: data.size,
      quality: data.quality,
      costMode: data.costMode,
      requestId: data.requestId,
    });
    if (data.consent.planHash !== result.planHash) {
      return NextResponse.json(
        { error: { code: "PLAN_CONSENT_MISMATCH", message: "The plan changed since it was previewed; review it again", plan: result.plan } },
        { status: 409 },
      );
    }
    const { data: job, error } = await supabase.rpc("enqueue_style_group_job", {
      p_style_id: render.style_id,
      p_requested_by: user.id,
      p_operation: "image_to_image",
      p_model: result.plan.effectiveModelId,
      p_packet: result.packet,
      p_mask_id: null,
    });
    if (error) throw error;
    return NextResponse.json({ job, plan: result.plan }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
