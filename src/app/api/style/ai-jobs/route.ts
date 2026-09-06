import { NextResponse } from "next/server";
import { AiJobSchema, providerForModel, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { compileStyledPrompt } from "@/lib/style/service";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { assertModelSupports } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getProviderApiKey } from "@/lib/ai/credentials";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { z } from "zod";

const StyleJobSchema = z.object({
  model: z.string().min(1),
  styleId: z.string().uuid(),
  sourceUrl: z.string().url(),
  prompt: z.string().trim().max(8000).optional(),
  count: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
});

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50));
  const { data, error } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("module", "style")
    .not("input->>style_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load style jobs" } }, { status: 500 });

  const parsedJobs = (data ?? []).map((job) => AiJobSchema.safeParse(job)).filter((result) => result.success).map((result) => result.data).reverse();
  const jobs: ProjectJobFeedItem[] = await Promise.all(parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })));
  return NextResponse.json({ jobs });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = StyleJobSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  try {
    if (!styleProfilesEnabled()) throw new Error("INVALID_REQUEST");
    const model = await assertModelSupports(parsed.data.model, "text_to_image");
    if (!(await getProviderApiKey(model.provider, { user: supabase, service: getServiceClient() }))) throw new Error("PROVIDER_NOT_CONFIGURED");
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
    if (!member) throw new Error("NOT_FOUND");

    const prompt = await compileStyledPrompt({ styleId: parsed.data.styleId, originalPrompt: parsed.data.prompt ?? "", client: supabase });
    const { data: job, error } = await supabase.rpc("enqueue_ai_job", {
      p_workspace_id: member.workspace_id,
      p_project_id: null,
      p_requested_by: user.id,
      p_operation: "text_to_image",
      p_provider: providerForModel(parsed.data.model),
      p_model: parsed.data.model,
      p_prompt: prompt,
      p_count: parsed.data.count,
      p_size: parsed.data.size,
      p_quality: parsed.data.quality,
      p_asset_id: null,
      p_parent_version_id: null,
      p_mask_storage_path: null,
      p_style_id: parsed.data.styleId,
      p_original_prompt: parsed.data.prompt ?? null,
      p_module: "style",
    });
    if (error) throw error;
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_REQUEST";
    const code = ["NOT_FOUND", "INVALID_MODEL", "PROVIDER_NOT_CONFIGURED", "STYLE_NOT_FOUND", "STYLE_NOT_ACTIVE"].find((candidate) => message.includes(candidate)) ?? "INVALID_REQUEST";
    return NextResponse.json({ error: { code, message } }, { status: message.includes("NOT_FOUND") || message.includes("STYLE_NOT_FOUND") ? 404 : message.includes("PROVIDER_NOT_CONFIGURED") ? 503 : 400 });
  }
}
