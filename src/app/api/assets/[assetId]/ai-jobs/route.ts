import { NextResponse } from "next/server";
import { InpaintEnqueueSchema, providerForModel } from "@/db/ai-jobs";
import { assertModelSupports } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getProviderApiKey } from "@/lib/ai/credentials";

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = InpaintEnqueueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  try {
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
    if (!member) throw new Error("NOT_FOUND");
    const workspaceId = member.workspace_id;
    const model = await assertModelSupports(parsed.data.model, "inpaint", supabase, workspaceId);
    if (!(await getProviderApiKey(model.provider, { user: supabase, service: getServiceClient(), workspaceId }))) throw new Error("PROVIDER_NOT_CONFIGURED");
    if (!model.qualities.includes(parsed.data.quality as never)) throw new Error("INVALID_MODEL");
    const { data: job, error } = await supabase.rpc("enqueue_inpaint_job_v2", {
      p_mask_id: parsed.data.maskId,
      p_requested_by: user.id,
      p_provider: model.provider,
      p_model: parsed.data.model,
      p_prompt: parsed.data.prompt,
      p_quality: parsed.data.quality,
    });
    if (error) throw error;
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_REQUEST";
    const code = ["NOT_FOUND", "VERSION_CONFLICT", "INVALID_MODEL", "PROVIDER_NOT_CONFIGURED", "quota_exceeded", "QUOTA_UNAVAILABLE"].find((candidate) => message.includes(candidate)) ?? "INVALID_REQUEST";
    const status = code === "NOT_FOUND" ? 404 : code === "VERSION_CONFLICT" ? 409 : code === "PROVIDER_NOT_CONFIGURED" ? 503 : code === "quota_exceeded" ? 429 : code === "QUOTA_UNAVAILABLE" ? 503 : 400;
    return NextResponse.json({ error: { code, message } }, { status });
  }
}
