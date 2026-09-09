import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { resolveUserWorkspaceId } from "@/lib/ai/models";
import { resolveImageExecutionPlan } from "@/lib/ai/execution-plan";
import { AiOperationSchema } from "@/db/ai-jobs";
import { z } from "zod";

const PlanRequestSchema = z.object({
  operation: AiOperationSchema,
  requestedModelId: z.string().min(1),
  styleId: z.string().uuid().optional(),
  sourceVersionId: z.string().uuid().optional(),
  costMode: z.enum(["strict_style", "strict_1000", "balanced", "quality"]).default("strict_1000"),
  count: z.number().int().min(1).max(4).default(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
  consent: z.object({ effectiveModelId: z.string().min(1), referenceIds: z.array(z.string().uuid()), styleBudget: z.number(), temperature: z.number().nullable(), modelChanged: z.boolean() }).optional(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = PlanRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const workspaceId = await resolveUserWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });

  if (parsed.data.operation === "image_to_image" && !parsed.data.sourceVersionId) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "sourceVersionId required for image_to_image" } }, { status: 400 });
  }
  try {
    const plan = await resolveImageExecutionPlan(supabase, parsed.data);
    if (parsed.data.consent) {
      const consent = parsed.data.consent;
      const mismatch = consent.effectiveModelId !== plan.effectiveModelId
        || consent.styleBudget !== plan.styleBudget
        || consent.temperature !== plan.temperature
        || consent.modelChanged !== plan.modelChanged
        || consent.referenceIds.join(",") !== plan.referenceIds.join(",");
      if (mismatch) return NextResponse.json({ error: { code: "PLAN_CONSENT_MISMATCH", message: "Execution plan changed; consent must be renewed", plan } }, { status: 409 });
    }
    return NextResponse.json({ plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve execution plan";
    return NextResponse.json({ error: { code: "PLAN_FAILED", message } }, { status: 400 });
  }
}
