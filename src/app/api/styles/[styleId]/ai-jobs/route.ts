import { NextResponse } from "next/server";
import { AiJobSchema, CostModeSchema, FEED_COLUMNS, FEED_LIMIT, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { resolveStyleGenerationPlan } from "@/lib/style/generation-plan";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { createClient } from "@/supabase/server";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { apiErrorFrom } from "@/lib/http/api-errors";
import { z } from "zod";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const ContentOverridesSchema = z.record(z.string(), z.unknown()).nullable().optional();
const ReferenceIdsSchema = z.array(z.string().uuid());
const ConsentSchema = z.object({ planHash: z.string().min(1) }).strict();
const BackgroundSchema = z.literal("transparent").nullable().optional();
const StyleGroupJobSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("text_to_image"), model: z.string().min(1), prompt: z.string().trim().min(1).max(8000), referenceIds: ReferenceIdsSchema.default([]), libraryReferenceIds: ReferenceIdsSchema.default([]), contentOverrides: ContentOverridesSchema.nullable().optional(), size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"), quality: z.enum(["low", "medium", "high", "auto"]).default("auto"), count: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1), costMode: CostModeSchema.default("strict_1000"), background: BackgroundSchema, consent: ConsentSchema }),
  z.object({ operation: z.literal("image_to_image"), model: z.string().min(1), prompt: z.string().trim().min(1).max(8000), referenceIds: ReferenceIdsSchema.default([]), libraryReferenceIds: ReferenceIdsSchema.default([]), contentOverrides: ContentOverridesSchema.nullable().optional(), sourceVersionId: z.string().uuid(), size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"), quality: z.enum(["low", "medium", "high", "auto"]).default("auto"), count: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1), costMode: CostModeSchema.default("strict_1000"), background: BackgroundSchema, consent: ConsentSchema }),
]);
export const maxDuration = 120;


export async function GET(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  // No style lookup: the job query is already scoped by style_id and RLS, and a
  // style without jobs answers with an empty feed.
  const limit = Math.max(1, Math.min(50, Math.floor(Number(new URL(request.url).searchParams.get("limit") ?? FEED_LIMIT))));
  // Every column the feed renders, minus style_generation: that packet is ~6 KB per
  // job and no client code reads it.
  const { data, error } = await supabase.from("ai_jobs").select(FEED_COLUMNS).eq("style_id", styleId).eq("module", "style").order("created_at", { ascending: false }).limit(limit);
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED" } }, { status: 500 });
  const jobs = await Promise.all((data ?? []).map(async (raw) => { const parsed = AiJobSchema.safeParse(raw); return parsed.success ? { job: parsed.data, result_urls: await getJobResultUrls(supabase, parsed.data) } : null; }));
  return NextResponse.json({ jobs: jobs.filter((job): job is ProjectJobFeedItem => job !== null).reverse() });
}

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = StyleGroupJobSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    if (!styleProfilesEnabled()) throw new Error("INVALID_REQUEST");
    const data = parsed.data;
    const result = await resolveStyleGenerationPlan(supabase, { operation: data.operation, requestedModelId: data.model, styleId, sourceVersionId: data.operation === "image_to_image" ? data.sourceVersionId : undefined, prompt: data.prompt, referenceIds: data.referenceIds, libraryReferenceIds: data.libraryReferenceIds, background: data.background ?? null, contentOverrides: data.contentOverrides ?? null, costMode: data.costMode, count: data.count, size: data.size, quality: data.quality, preserveRequestedModel: true });
    if (data.consent.planHash !== result.plan.planHash) return NextResponse.json({ error: { code: "PLAN_CONSENT_MISMATCH", message: "Execution plan changed; consent must be renewed", plan: result.plan } }, { status: 409 });
    const { data: job, error } = await supabase.rpc("enqueue_style_group_job", { p_style_id: styleId, p_requested_by: user.id, p_operation: data.operation, p_model: result.plan.effectiveModelId, p_packet: result.packet, p_mask_id: null });
    if (error) throw error;
    return NextResponse.json({ job, plan: result.plan }, { status: 202 });
  } catch (error) {
    const failure = apiErrorFrom(error);
    return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
  }
}
