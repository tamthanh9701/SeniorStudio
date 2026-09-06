import { NextRequest, NextResponse } from "next/server";
import { createClient, getServiceClient } from "@/supabase/server";
import { STORAGE_BUCKET } from "@/db/schema";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: assets } = await supabase
    .from("assets")
    .select("id")
    .eq("project_id", projectId);

  const assetIds = (assets ?? []).map((asset) => asset.id);

  let storagePaths: string[] = [];

  if (assetIds.length > 0) {
    const [versionsResult, masksResult] = await Promise.all([
      supabase.from("asset_versions").select("storage_path").in("asset_id", assetIds),
      supabase.from("ai_job_inputs").select("storage_path").in("asset_id", assetIds),
    ]);

    storagePaths = [
      ...(versionsResult.data ?? []).map((v) => v.storage_path),
      ...(masksResult.data ?? []).map((m) => m.storage_path),
    ];
  }

  const { error: deleteError } = await supabase
    .from("projects")
    .delete()
    .eq("id", projectId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  if (storagePaths.length > 0) {
    const service = getServiceClient();
    for (let i = 0; i < storagePaths.length; i += 100) {
      const chunk = storagePaths.slice(i, i + 100);
      await service.storage.from(STORAGE_BUCKET).remove(chunk);
    }
  }

  return NextResponse.json({ ok: true });
}
