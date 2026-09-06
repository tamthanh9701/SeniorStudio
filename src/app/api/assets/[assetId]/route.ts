import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: asset, error: assetError } = await supabase
    .from("assets")
    .select("*")
    .eq("id", assetId)
    .single();

  if (assetError || !asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  let version = null;
  let signedUrl = null;

  if (asset.current_version_id) {
    const { data: versionData } = await supabase
      .from("asset_versions")
      .select("*")
      .eq("id", asset.current_version_id)
      .single();

    if (versionData) {
      version = versionData;
      signedUrl = await getSignedUrl(supabase, versionData.storage_path);
    }
  }

  return NextResponse.json({ asset, version, signed_url: signedUrl });
}
import { getServiceClient } from "@/supabase/server";
import { STORAGE_BUCKET } from "@/db/schema";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: asset, error: assetError } = await supabase
    .from("assets")
    .select("id")
    .eq("id", assetId)
    .single();

  if (assetError || !asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const { data: versions } = await supabase
    .from("asset_versions")
    .select("storage_path")
    .eq("asset_id", assetId);

  const { data: masks } = await supabase
    .from("ai_job_inputs")
    .select("storage_path")
    .eq("asset_id", assetId);

  const storagePaths = [
    ...(versions ?? []).map((v) => v.storage_path),
    ...(masks ?? []).map((m) => m.storage_path),
  ];

  const { error: deleteError } = await supabase
    .from("assets")
    .delete()
    .eq("id", assetId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  if (storagePaths.length > 0) {
    const service = getServiceClient();
    await service.storage.from(STORAGE_BUCKET).remove(storagePaths);
  }

  return NextResponse.json({ ok: true });
}
