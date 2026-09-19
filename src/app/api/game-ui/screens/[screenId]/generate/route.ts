// Generate a screen image for a Game UI screen draft.  The plan is rebuilt from
// the server's authority and compared with the consent the browser saw before
// anything is charged, exactly like the visual style enqueue.
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireGameUiStyle, requireOwnedScreen } from "@/lib/game-ui/http";
import { resolveGameUiScreenPlan } from "@/lib/game-ui/generation-plan";
import { CostModeSchema, SupportedQualitySchema, SupportedSizeSchema } from "@/db/ai-jobs";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const maxDuration = 120;

const GenerateSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    model: z.string().regex(/^(openai|google)\/[a-z0-9._-]+$/),
    size: SupportedSizeSchema,
    quality: SupportedQualitySchema,
    count: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    referenceIds: z.array(z.string().uuid()).min(1),
    costMode: CostModeSchema.default("strict_1000"),
    requestId: z.string().uuid(),
    consent: z.object({ planHash: z.string().min(1) }).strict(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ screenId: string }> }) {
  const { screenId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = GenerateSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }
  try {
    const screen = await requireOwnedScreen(supabase, screenId);
    await requireGameUiStyle(supabase, screen.style_id);
    const data = parsed.data;
    const service = getServiceClient();
    const result = await resolveGameUiScreenPlan(supabase, service, {
      screenId,
      expectedRevision: data.expectedRevision,
      model: data.model,
      size: data.size,
      quality: data.quality,
      count: data.count,
      referenceIds: data.referenceIds,
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
      p_style_id: screen.style_id,
      p_requested_by: user.id,
      p_operation: result.plan.operation,
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
