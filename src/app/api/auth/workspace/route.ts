import { NextResponse } from "next/server";
import { getEnv } from "@/env";
import { getServiceClient } from "@/supabase/server";

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
