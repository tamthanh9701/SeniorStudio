import { NextResponse } from "next/server";
import { getEnv } from "@/env";
import { createClient, getServiceClient } from "@/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data: projects } = await supabase.from("projects").select("id, name").order("created_at", { ascending: false });
  return NextResponse.json({ user: { email: user.email }, projects: projects ?? [] });
}

export async function POST(request: Request) {
  const { email } = await request.json();
  const env = getEnv();

  if (email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServiceClient();
  
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .limit(1)
    .single();

  if (workspace) {
    return NextResponse.json({ workspace_id: workspace.id });
  }

  const { data: newWorkspace, error } = await supabase
    .from("workspaces")
    .insert({ name: "Default Workspace" })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ workspace_id: newWorkspace.id });
}
