import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";

const UpdateLibrarySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  sort_order: z.number().int().nonnegative().optional(),
});

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ libraryId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { libraryId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = UpdateLibrarySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Invalid update data" } }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.sort_order !== undefined) updates.sort_order = parsed.data.sort_order;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "No fields to update" } }, { status: 400 });
  }

  const { data: library, error } = await supabase
    .from("style_libraries")
    .update(updates)
    .eq("id", libraryId)
    .select("id, workspace_id, name, sort_order, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: { code: "UPDATE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ library });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ libraryId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { libraryId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  // Library deletion cascades to styles via ON DELETE SET NULL (library_id -> null)
  const { error } = await supabase.from("style_libraries").delete().eq("id", libraryId);

  if (error) return NextResponse.json({ error: { code: "DELETE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ success: true });
}
