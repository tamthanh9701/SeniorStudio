import { NextResponse } from "next/server";
import { AiJobSchema, FEED_COLUMNS, TextToImageEnqueueSchema, providerForModel, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { assertModelSupports } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getEnv } from "@/env";
import { getProviderApiKey } from "@/lib/ai/credentials";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { apiErrorFrom } from "@/lib/http/api-errors";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle();
  if (!project) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Project not found" } }, { status: 404 });
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50));
  // Every column the feed renders, minus style_generation (see the style feed route).
  const { data, error } = await supabase.from("ai_jobs").select(FEED_COLUMNS).eq("project_id", projectId).order("created_at", { ascending: false }).limit(limit);
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load project jobs" } }, { status: 500 });
  const parsedJobs = (data ?? []).map((job) => AiJobSchema.safeParse(job)).filter((result) => result.success).map((result) => result.data).reverse();
  const jobs: ProjectJobFeedItem[] = await Promise.all(parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })));
  return NextResponse.json({ jobs });
}


export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = TextToImageEnqueueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
    if (!member) throw new Error("NOT_FOUND");
    const workspaceId = member.workspace_id;
    const model = await assertModelSupports(parsed.data.model, "text_to_image", supabase, workspaceId);
    if (!(await getProviderApiKey(model.provider, { user: supabase, service: getServiceClient(), workspaceId }))) throw new Error("PROVIDER_NOT_CONFIGURED");
    if (!model.sizes.includes(parsed.data.size as never) || !model.qualities.includes(parsed.data.quality as never)) throw new Error("INVALID_MODEL");
    // Project generation never applies a style: a style is applied only in the
    // Style module, where the confirmed definition and its reference images are
    // enforced.  Accepting a style here would produce images that bypass both.
    const { data: job, error } = await supabase.rpc("enqueue_text_to_image_job_v2", {
      p_workspace_id: workspaceId, p_project_id: projectId, p_requested_by: user.id,
      p_provider: providerForModel(parsed.data.model), p_model: parsed.data.model,
      p_prompt: parsed.data.prompt, p_count: parsed.data.count, p_size: parsed.data.size, p_quality: parsed.data.quality,
      p_style_id: null, p_original_prompt: null,
      p_module: "projects", p_cost_mode: parsed.data.costMode,
      p_requested_model_id: parsed.data.model, p_reference_ids: [], p_temperature: null,
    });
    if (error) throw error;
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const failure = apiErrorFrom(error);
    return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
  }
}
