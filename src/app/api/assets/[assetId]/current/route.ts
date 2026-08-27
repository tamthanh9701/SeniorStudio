import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/supabase/server";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { versionId } = await request.json();

  if (!versionId) {
    return NextResponse.json({ error: "Missing versionId" }, { status: 400 });
  }

  // Verify version belongs to asset
  const { data: version } = await supabase
    .from("asset_versions")
    .select("asset_id")
    .eq("id", versionId)
    .single();

  if (!version || version.asset_id !== assetId) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  // Update asset current_version_id
  const { error } = await supabase
    .from("assets")
    .update({ current_version_id: versionId, updated_at: new Date().toISOString() })
    .eq("id", assetId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
