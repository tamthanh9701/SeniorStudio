import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";

export const CreateProjectSchema = z.object({ name: z.string().trim().min(1).max(100) });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = CreateProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Project name must be between 1 and 100 characters" } }, { status: 400 });
  const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
  if (!member) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });
  const { data: project, error } = await supabase.from("projects").insert({ workspace_id: member.workspace_id, name: parsed.data.name }).select().single();
  if (error || !project) return NextResponse.json({ error: { code: "CREATE_FAILED", message: "Unable to create project" } }, { status: 500 });
  return NextResponse.json({ project }, { status: 201 });
}
