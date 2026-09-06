// Style CRUD routes. RLS scopes every query to the caller's workspaces; the
// flag check keeps the whole surface dark when STYLE_PROFILES_ENABLED=false.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";

const CreateStyleSchema = z.object({ name: z.string().trim().min(1).max(100) });

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

export async function GET() {
  if (!styleProfilesEnabled()) return flagDisabled();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const { data, error } = await supabase
    .from("styles")
    .select("id, name, status, created_at, updated_at, style_references(count)")
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load styles" } }, { status: 500 });
  const styles = (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    referenceCount: row.style_references?.[0]?.count ?? 0,
    updatedAt: row.updated_at,
  }));
  return NextResponse.json({ styles });
}

export async function POST(request: Request) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = CreateStyleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Name must be 1-100 characters" } }, { status: 400 });
  const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
  if (!member) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });
  const { data: style, error } = await supabase
    .from("styles")
    .insert({ workspace_id: member.workspace_id, name: parsed.data.name })
    .select("id, name, status, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: { code: "CREATE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ style: { ...style, referenceCount: 0 } }, { status: 201 });
}

