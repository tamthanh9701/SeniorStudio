import { NextResponse } from "next/server";
import { CreateChatMessageSchema } from "@/db/browser-bridge";
import { createClient } from "@/supabase/server";

function rpcError(error: { message: string }) {
  const code = ["THREAD_BUSY", "VERSION_CONFLICT", "NOT_FOUND"].find((candidate) => error.message.includes(candidate));
  const status = code === "THREAD_BUSY" ? 409 : code === "VERSION_CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : 500;
  return NextResponse.json({ error: code ?? "ENQUEUE_FAILED" }, { status });
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const parsed = CreateChatMessageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });

  const { data: member } = await supabase.from("workspace_members").select("workspace_id")
    .eq("supabase_user_id", user.id).maybeSingle();
  if (!member) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const { data, error } = await supabase.rpc("enqueue_browser_job", {
    p_workspace_id: member.workspace_id, p_project_id: projectId,
    p_thread_id: parsed.data.threadId ?? null, p_operation: parsed.data.mode,
    p_prompt: parsed.data.message, p_parent_version_id: parsed.data.parentVersionId ?? null,
  });
  if (error) return rpcError(error);
  return NextResponse.json(data, { status: 202 });
}
