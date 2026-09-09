import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { resolveUserWorkspaceId } from "@/lib/ai/models";
import { getAiQuotaLimit } from "@/lib/ai/quota";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const workspaceId = await resolveUserWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });

  const { data, error } = await supabase.rpc("get_ai_quota_status", { p_workspace_id: workspaceId });
  if (error) return NextResponse.json({ error: { code: "QUOTA_UNAVAILABLE", message: error.message } }, { status: 503 });

  return NextResponse.json(data);
}
