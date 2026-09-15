// Single reference retirement.  The row and its bytes are retained because
// confirmed definitions and historical generation packets resolve references by
// id and content hash; retiring only removes it from the editable set.
import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
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
  const { error } = await supabase.rpc("retire_style_reference", { p_style_id: styleId, p_reference_id: referenceId });
  if (error) {
    const notFound = error.message.includes("NOT_FOUND") || error.message.includes("STYLE_NOT_FOUND");
    return NextResponse.json(
      { error: { code: notFound ? "STYLE_NOT_FOUND" : "DELETE_FAILED", message: notFound ? "Reference not found" : error.message } },
      { status: notFound ? 404 : 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
