import { NextResponse } from "next/server";
import { AiJobSchema, TextToImageEnqueueSchema, providerForModel, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { compileStyledPrompt } from "@/lib/style/service";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { assertModelSupports } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getEnv } from "@/env";
import { getProviderApiKey } from "@/lib/ai/credentials";
import { getJobResultUrls } from "@/lib/ai/job-results";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle();
  if (!project) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Project not found" } }, { status: 404 });
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50));
  const { data, error } = await supabase.from("ai_jobs").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(limit);
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load project jobs" } }, { status: 500 });
  const parsedJobs = (data ?? []).map((job) => AiJobSchema.safeParse(job)).filter((result) => result.success).map((result) => result.data).reverse();
  const jobs: ProjectJobFeedItem[] = await Promise.all(parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })));
  return NextResponse.json({ jobs });
}

function statusForError(message: string) {
  if (message.includes("NOT_FOUND")) return 404;
  if (message.includes("PROVIDER_NOT_CONFIGURED")) return 503;
  return 400;
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = TextToImageEnqueueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    const model = await assertModelSupports(parsed.data.model, "text_to_image");
    if (!(await getProviderApiKey(model.provider, { user: supabase, service: getServiceClient() }))) throw new Error("PROVIDER_NOT_CONFIGURED");
    if (!model.sizes.includes(parsed.data.size as never) || !model.qualities.includes(parsed.data.quality as never)) throw new Error("INVALID_MODEL");
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
    if (!member) throw new Error("NOT_FOUND");
    let prompt = parsed.data.prompt;
    let styleId: string | null = null;
    if (parsed.data.styleId) {
      if (!styleProfilesEnabled()) throw new Error("INVALID_REQUEST");
      styleId = parsed.data.styleId;
      prompt = await compileStyledPrompt({ styleId: parsed.data.styleId, originalPrompt: parsed.data.prompt, client: supabase });
    }
    const { data: job, error } = await supabase.rpc("enqueue_ai_job", {
      p_workspace_id: member.workspace_id, p_project_id: projectId, p_requested_by: user.id,
      p_operation: parsed.data.operation, p_provider: providerForModel(parsed.data.model), p_model: parsed.data.model,
      p_prompt: prompt, p_count: parsed.data.count, p_size: parsed.data.size, p_quality: parsed.data.quality,
      p_asset_id: null, p_parent_version_id: null, p_mask_storage_path: null,
      p_style_id: styleId, p_original_prompt: styleId ? parsed.data.prompt : null,
    });
    if (error) throw error;
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_REQUEST";
    const code = ["NOT_FOUND", "INVALID_MODEL", "PROVIDER_NOT_CONFIGURED", "STYLE_NOT_FOUND", "STYLE_NOT_ACTIVE"].find((candidate) => message.includes(candidate)) ?? "INVALID_REQUEST";
    return NextResponse.json({ error: { code, message } }, { status: statusForError(message) });
  }
}
