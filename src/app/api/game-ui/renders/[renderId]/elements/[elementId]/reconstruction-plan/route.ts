// Preview the element reconstruction plan without spending anything.  The
// browser consents to this exact hash; the enqueue then rebuilds the plan from
// server authority, so a preview can never be edited into a different charge.
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { resolveGameUiReconstructionPlan } from "@/lib/game-ui/generation-plan";
import { CostModeSchema, SupportedQualitySchema, SupportedSizeSchema } from "@/db/ai-jobs";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const maxDuration = 60;

const PlanSchema = z
  .object({
    elementSetId: z.string().uuid(),
    instruction: z.string().trim().min(1).max(2000),
    model: z.string().regex(/^(openai|google)\/[a-z0-9._-]+$/),
    size: SupportedSizeSchema,
    quality: SupportedQualitySchema,
    costMode: CostModeSchema.default("strict_1000"),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ renderId: string; elementId: string }> }) {
  const { renderId, elementId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = PlanSchema.safeParse(await readJson(request));
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
    // A preview is not an enqueue, so it must not claim an idempotency key: the
    // request id lives in the packet the browser later consents to.
    const result = await resolveGameUiReconstructionPlan(supabase, getServiceClient(), {
      renderId,
      elementSetId: data.elementSetId,
      elementId,
      instruction: data.instruction,
      model: data.model,
      size: data.size,
      quality: data.quality,
      costMode: data.costMode,
      requestId: crypto.randomUUID(),
    });
    return NextResponse.json({ plan: result.plan, planHash: result.planHash });
  } catch (error) {
    return errorResponse(error);
  }
}
