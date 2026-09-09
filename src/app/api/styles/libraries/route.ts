import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";

const CreateLibrarySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

export async function GET() {
  if (!styleProfilesEnabled()) return flagDisabled();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const { data, error } = await supabase
    .from("style_libraries")
    .select("id, workspace_id, name, sort_order, created_at, updated_at")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load libraries" } }, { status: 500 });

  return NextResponse.json({ libraries: data ?? [] });
}

export async function POST(request: Request) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = CreateLibrarySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Name must be 1-100 characters" } }, { status: 400 });

  const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
  if (!member) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });

  // Get next sort_order
  const { data: existing } = await supabase.from("style_libraries").select("sort_order").eq("workspace_id", member.workspace_id).order("sort_order", { ascending: false }).limit(1).single();
  const nextSortOrder = (existing?.sort_order ?? -1) + 1;

  const { data: library, error } = await supabase
    .from("style_libraries")
    .insert({ workspace_id: member.workspace_id, name: parsed.data.name, sort_order: nextSortOrder })
    .select("id, workspace_id, name, sort_order, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: { code: "CREATE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ library }, { status: 201 });
}
