// Preview the generation plan for a screen draft.  The plan is rebuilt from the
// server's authority (confirmed style, attached wireframe, draft revision) and
// carries the hash the browser consents to before generate enqueues anything.
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveGameUiScreenPlan } from "@/lib/game-ui/generation-plan";
import { errorResponse, readJson, requireGameUiStyle, requireOwnedScreen } from "@/lib/game-ui/http";
import { CostModeSchema, GenerationCountSchema, SupportedModelIdSchema, SupportedQualitySchema, SupportedSizeSchema } from "@/db/ai-jobs";
import { MAX_STYLE_REFERENCES } from "@/lib/style/reference-limits";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

/** The plan reads the model catalog from the provider before it can price the job. */
export const maxDuration = 120;

const PlanSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    model: SupportedModelIdSchema,
    size: SupportedSizeSchema,
    quality: SupportedQualitySchema,
    count: GenerationCountSchema,
    referenceIds: z.array(z.string().uuid()).min(1).max(MAX_STYLE_REFERENCES),
    costMode: CostModeSchema.default("strict_1000"),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ screenId: string }> }) {
  const { screenId } = await params;
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
    const screen = await requireOwnedScreen(supabase, screenId);
    await requireGameUiStyle(supabase, screen.style_id);
    // A preview is not a commitment: the request id is fresh each time, so the
    // consent hash the generate step compares against cannot be replayed here.
    const result = await resolveGameUiScreenPlan(supabase, getServiceClient(), {
      screenId,
      expectedRevision: parsed.data.expectedRevision,
      model: parsed.data.model,
      size: parsed.data.size,
      quality: parsed.data.quality,
      count: parsed.data.count,
      referenceIds: parsed.data.referenceIds,
      costMode: parsed.data.costMode,
      requestId: crypto.randomUUID(),
    });
    return NextResponse.json({ plan: result.plan });
  } catch (error) {
    return errorResponse(error);
  }
}
