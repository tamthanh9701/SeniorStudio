import { NextResponse } from "next/server";
import { AiJobSchema, CostModeSchema, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { resolveStyleGenerationPlan } from "@/lib/style/generation-plan";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { createClient } from "@/supabase/server";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { z } from "zod";

const ContentOverridesSchema = z.record(z.string(), z.unknown()).nullable().optional();
const ReferenceIdsSchema = z.array(z.string().uuid());
const ConsentSchema = z.object({ planHash: z.string().min(1) }).strict();
const StyleGroupJobSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("text_to_image"), model: z.string().min(1), prompt: z.string().trim().min(1).max(8000), referenceIds: ReferenceIdsSchema.default([]), contentOverrides: ContentOverridesSchema.nullable().optional(), size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"), quality: z.enum(["low", "medium", "high", "auto"]).default("auto"), count: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1), costMode: CostModeSchema.default("strict_1000"), consent: ConsentSchema }),
  z.object({ operation: z.literal("image_to_image"), model: z.string().min(1), prompt: z.string().trim().min(1).max(8000), referenceIds: ReferenceIdsSchema.default([]), contentOverrides: ContentOverridesSchema.nullable().optional(), sourceVersionId: z.string().uuid(), size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"), quality: z.enum(["low", "medium", "high", "auto"]).default("auto"), count: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1), costMode: CostModeSchema.default("strict_1000"), consent: ConsentSchema }),
]);
export const maxDuration = 120;

function statusForError(message: string): number {
  if (message.includes("NOT_FOUND") || message.includes("SOURCE_NOT_FOUND") || message.includes("REFERENCE_NOT_FOUND")) return 404;
  if (message.includes("PROVIDER_NOT_CONFIGURED")) return 503;
  if (message.includes("quota_exceeded")) return 429;
  if (message.includes("STYLE_NOT_ACTIVE") || message.includes("VERSION_CONFLICT") || message.includes("PLAN_CONSENT_MISMATCH")) return 409;
  return 400;
}

export async function GET(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data: style } = await supabase.from("styles").select("id").eq("id", styleId).single();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND" } }, { status: 404 });
  const limit = Math.max(1, Math.min(50, Math.floor(Number(new URL(request.url).searchParams.get("limit") ?? 50))));
  const { data, error } = await supabase.from("ai_jobs").select("*").eq("style_id", styleId).eq("module", "style").order("created_at", { ascending: false }).limit(limit);
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED" } }, { status: 500 });
  const jobs = await Promise.all((data ?? []).map(async (raw) => { const parsed = AiJobSchema.safeParse(raw); return parsed.success ? { job: parsed.data, result_urls: await getJobResultUrls(supabase, parsed.data) } : null; }));
  return NextResponse.json({ jobs: jobs.filter((job): job is ProjectJobFeedItem => job !== null).reverse() });
}

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = StyleGroupJobSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    if (!styleProfilesEnabled()) throw new Error("INVALID_REQUEST");
    const data = parsed.data;
    const result = await resolveStyleGenerationPlan(supabase, { operation: data.operation, requestedModelId: data.model, styleId, sourceVersionId: data.operation === "image_to_image" ? data.sourceVersionId : undefined, prompt: data.prompt, referenceIds: data.referenceIds, contentOverrides: data.contentOverrides ?? null, costMode: data.costMode, count: data.count, size: data.size, quality: data.quality, preserveRequestedModel: true });
    if (data.consent.planHash !== result.plan.planHash) return NextResponse.json({ error: { code: "PLAN_CONSENT_MISMATCH", message: "Execution plan changed; consent must be renewed", plan: result.plan } }, { status: 409 });
    const { data: job, error } = await supabase.rpc("enqueue_style_group_job", { p_style_id: styleId, p_requested_by: user.id, p_operation: data.operation, p_model: result.plan.effectiveModelId, p_packet: result.packet, p_mask_id: null });
    if (error) throw error;
    return NextResponse.json({ job, plan: result.plan }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_REQUEST";
    return NextResponse.json({ error: { code: message.split(":")[0], message } }, { status: statusForError(message) });
  }
}
