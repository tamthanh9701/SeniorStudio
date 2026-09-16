import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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
import { filterOwnedStoragePaths } from "@/lib/assets/ownership";
import { STORAGE_BUCKET } from "@/db/schema";

/** Only the owning container is needed to decide which objects this asset may remove. */
const AssetOwnerSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  style_id: z.string().uuid().nullable(),
  projects: z.object({ workspace_id: z.string().uuid() }).nullable(),
  styles: z.object({ workspace_id: z.string().uuid() }).nullable(),
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  }

  const { data: asset, error: assetError } = await supabase
    .from("assets")
    .select("id, project_id, style_id, projects!assets_project_id_fkey(workspace_id), styles!assets_style_id_fkey(workspace_id)")
    .eq("id", assetId)
    .single();

  if (assetError || !asset) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Asset not found" } }, { status: 404 });
  }

  const owner = AssetOwnerSchema.safeParse(asset);
  if (!owner.success) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Asset not found" } }, { status: 404 });
  }
  // The objects this asset owns, by the convention each writer uses.
  const { project_id: projectId, style_id: styleId } = owner.data;
  const project = owner.data.projects;
  const style = owner.data.styles;
  const ownerPrefixes = [
    ...(project && projectId ? [`${project.workspace_id}/${projectId}/${assetId}/`] : []),
    ...(style && styleId
      ? [`${style.workspace_id}/styles/${styleId}/outputs/${assetId}/`, `${style.workspace_id}/styles/${styleId}/sources/${assetId}/`]
      : []),
  ];
  if (ownerPrefixes.length === 0) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Asset not found" } }, { status: 404 });
  }

  const { data: versions } = await supabase
    .from("asset_versions")
    .select("id, storage_path")
    .eq("asset_id", assetId);

  // An image a running generation depends on must not disappear underneath it.
  const versionIds = (versions ?? []).map((version) => version.id);
  const dependencyFilter = versionIds.length > 0
    ? `asset_id.eq.${assetId},parent_version_id.in.(${versionIds.join(",")})`
    : `asset_id.eq.${assetId}`;
  const { data: runningJobs } = await supabase
    .from("ai_jobs")
    .select("id")
    .or(dependencyFilter)
    .not("status", "in", "(succeeded,failed,canceled)")
    .limit(1);

  if (runningJobs && runningJobs.length > 0) {
    return NextResponse.json(
      { error: { code: "ASSET_IN_USE", message: "A generation is still using this image. Wait for it to finish before deleting." } },
      { status: 409 },
    );
  }

  const { data: masks } = await supabase
    .from("ai_job_inputs")
    .select("storage_path")
    .eq("asset_id", assetId);

  const storagePaths = [
    ...(versions ?? []).map((version) => version.storage_path),
    ...(masks ?? []).map((mask) => mask.storage_path),
  ];

  const { error: deleteError } = await supabase
    .from("assets")
    .delete()
    .eq("id", assetId);

  if (deleteError) {
    const inUse = deleteError.message.includes("VERSION_IN_USE") || deleteError.code === "23503";
    return NextResponse.json(
      { error: { code: inUse ? "ASSET_IN_USE" : "DELETE_FAILED", message: inUse ? "A generation is still using this image." : deleteError.message } },
      { status: inUse ? 409 : 500 },
    );
  }

  // Rows are member-writable, so only this asset's own objects are removed.
  const { owned, rejected } = filterOwnedStoragePaths(storagePaths, ownerPrefixes);
  if (rejected.length > 0) console.error(`asset delete refused ${rejected.length} foreign storage path(s) asset=${assetId}`);
  if (owned.length > 0) {
    const service = getServiceClient();
    const { error: storageError } = await service.storage.from(STORAGE_BUCKET).remove(owned);
    if (storageError) console.error(`asset storage cleanup failed asset=${assetId}: ${storageError.message}`);
  }

  return NextResponse.json({ ok: true });
}

const RenameAssetSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  }
  const parsed = RenameAssetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Name must be 1-120 characters" } }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("assets")
    .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
    .eq("id", assetId)
    .select("id, name")
    .maybeSingle();
  if (error) return NextResponse.json({ error: { code: "UPDATE_FAILED", message: error.message } }, { status: 500 });
  if (!data) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Asset not found" } }, { status: 404 });
  return NextResponse.json({ asset: data });
}
