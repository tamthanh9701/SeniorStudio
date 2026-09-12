import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { resolveStyleGenerationPlan } from "@/lib/style/generation-plan";
import { resolveUserWorkspaceId } from "@/lib/ai/models";
import { resolveImageExecutionPlan } from "@/lib/ai/execution-plan";
import { AiOperationSchema } from "@/db/ai-jobs";
import { z } from "zod";

const PlanRequestSchema = z.object({
  operation: AiOperationSchema,
  requestedModelId: z.string().min(1),
  styleId: z.string().uuid().optional(),
  sourceVersionId: z.string().uuid().nullable().optional(),
  parentVersionId: z.string().uuid().nullable().optional(),
  maskId: z.string().uuid().nullable().optional(),
  sourceAssetId: z.string().uuid().nullable().optional(),
  prompt: z.string().max(8000).optional(),
  contentOverrides: z.record(z.string(), z.unknown()).nullable().optional(),
  editTarget: z.string().optional(),
  useCurrentStyle: z.boolean().optional(),
  referenceIds: z.array(z.string().uuid()).default([]),
  preserveRequestedModel: z.boolean().optional(),
  costMode: z.enum(["strict_style", "strict_1000", "balanced", "quality"]).default("strict_1000"),
  count: z.number().int().min(1).max(4).default(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
  consent: z.object({ effectiveModelId: z.string().min(1), referenceIds: z.array(z.string().uuid()), styleBudget: z.number(), temperature: z.number().nullable(), modelChanged: z.boolean() }).optional(),
}).strict();

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = PlanRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    const input = { ...parsed.data, sourceVersionId: parsed.data.sourceVersionId ?? undefined, parentVersionId: parsed.data.parentVersionId ?? undefined, maskId: parsed.data.maskId ?? undefined };
    if (parsed.data.styleId) {
      if (!parsed.data.prompt?.trim()) throw new Error("PROMPT_REQUIRED");
      if (parsed.data.operation === "inpaint") {
        if (!parsed.data.sourceVersionId || !parsed.data.sourceAssetId || !parsed.data.maskId) throw new Error("INVALID_REQUEST");
        const { data: asset } = await supabase.from("assets").select("id, style_id").eq("id", parsed.data.sourceAssetId).eq("style_id", parsed.data.styleId).single();
        const { data: source } = await supabase.from("asset_versions").select("id, prompt, style_generation").eq("id", parsed.data.sourceVersionId).eq("asset_id", parsed.data.sourceAssetId).single();
        if (!asset || !source) throw new Error("VERSION_CONFLICT");
        const result = await resolveStyleGenerationPlan(supabase, { ...input, styleId: parsed.data.styleId, prompt: parsed.data.prompt.trim(), referenceIds: parsed.data.referenceIds, sourceVersionId: parsed.data.sourceVersionId, sourceAssetId: parsed.data.sourceAssetId, sourcePacket: source.style_generation, sourceOriginalPrompt: source.prompt, maskId: parsed.data.maskId });
        return NextResponse.json({ plan: result.plan });
      }
      const result = await resolveStyleGenerationPlan(supabase, { ...input, styleId: parsed.data.styleId, prompt: parsed.data.prompt.trim(), referenceIds: parsed.data.referenceIds, sourceAssetId: null });
      return NextResponse.json({ plan: result.plan });
    }
    const workspaceId = await resolveUserWorkspaceId(supabase, user.id);
    if (!workspaceId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });
    if (parsed.data.operation === "image_to_image" && !parsed.data.sourceVersionId) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "sourceVersionId required for image_to_image" } }, { status: 400 });
    const plan = await resolveImageExecutionPlan(supabase, input);
    return NextResponse.json({ plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve execution plan";
    const code = message.includes("PROMPT_REQUIRED") ? "INVALID_REQUEST" : message.includes("REFERENCE_NOT_FOUND") ? "REFERENCE_NOT_FOUND" : message.includes("REFERENCE_LIMIT_EXCEEDED") ? "REFERENCE_LIMIT_EXCEEDED" : message.includes("STYLE_NOT_ACTIVE") ? "STYLE_NOT_ACTIVE" : message.includes("STYLE_NOT_FOUND") ? "STYLE_NOT_FOUND" : message.includes("PROVIDER_NOT_CONFIGURED") ? "PROVIDER_NOT_CONFIGURED" : message.includes("UNSUPPORTED_SETTINGS") ? "UNSUPPORTED_SETTINGS" : "PLAN_FAILED";
    const status = code === "STYLE_NOT_ACTIVE" ? 409 : code === "PROVIDER_NOT_CONFIGURED" ? 503 : ["REFERENCE_NOT_FOUND", "STYLE_NOT_FOUND"].includes(code) ? 404 : 400;
    return NextResponse.json({ error: { code, message } }, { status });
  }
}
