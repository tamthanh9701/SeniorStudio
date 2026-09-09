// Single reference deletion: storage object first, then the row.
import { NextResponse } from "next/server";
import { createClient, getServiceClient } from "@/supabase/server";
import { STORAGE_BUCKET } from "@/db/schema";
import { styleProfilesEnabled } from "@/lib/style/flag";

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ styleId: string; referenceId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId, referenceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  // RLS on style_references joins through styles, so cross-workspace reads 404 here.
  const { data: reference } = await supabase
    .from("style_references")
    .select("id, storage_path")
    .eq("id", referenceId)
    .eq("style_id", styleId)
    .maybeSingle();
  if (!reference) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Reference not found" } }, { status: 404 });

  const { data: style } = await supabase
    .from("styles").select("workspace_id").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  // Validate path ownership before privileged delete.
  const styleIdPrefix = `${style.workspace_id}/`;
  if (!reference.storage_path.startsWith(styleIdPrefix)) {
    console.error(`reference storage_path mismatch: path=${reference.storage_path} style_ws=${style.workspace_id}`);
    return NextResponse.json({ error: { code: "DELETE_FAILED", message: "Reference path ownership mismatch" } }, { status: 500 });
  }

  try {
    // DB delete first — fail-closed on row error.
    const { error } = await supabase.from("style_references").delete().eq("id", referenceId);
    if (error) return NextResponse.json({ error: { code: "DELETE_FAILED", message: error.message } }, { status: 500 });

    // Storage remove is best-effort after confirmed DB delete.
    const { error: storageError } = await getServiceClient().storage.from(STORAGE_BUCKET).remove([reference.storage_path]);
    if (storageError) console.error(`reference storage remove failed path=${reference.storage_path}: ${storageError.message}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: { code: "DELETE_FAILED", message } }, { status: 500 });
  }
}
