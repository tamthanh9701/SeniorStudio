import { NextResponse } from "next/server";
import sharp from "sharp";
import { MaskUploadSchema } from "@/db/ai-jobs";
import { STORAGE_BUCKET } from "@/db/schema";
import { createClient, getServiceClient } from "@/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = MaskUploadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });
  const bytes = new Uint8Array(Buffer.from(parsed.data.maskPng.replace(/^data:image\/png;base64,/, ""), "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) return NextResponse.json({ error: { code: "INVALID_REQUEST" } }, { status: 400 });
  const metadata = await sharp(bytes, { failOn: "error" }).metadata().catch(() => null);
  if (metadata?.format !== "png" || !metadata.width || !metadata.height || metadata.channels !== 4) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Mask must be RGBA PNG" } }, { status: 400 });
  const { data: version, error: versionError } = await supabase.from("asset_versions").select("id, asset_id, width, height, assets!asset_versions_asset_id_fkey(project_id, style_id)").eq("id", parsed.data.parentVersionId).eq("asset_id", assetId).single();
  if (versionError || !version) return NextResponse.json({ error: { code: versionError?.code === "PGRST301" ? "UNAUTHORIZED" : "NOT_FOUND", message: versionError?.message } }, { status: versionError?.code === "PGRST301" ? 401 : 404 });
  if (version.width !== metadata.width || version.height !== metadata.height) return NextResponse.json({ error: { code: "VERSION_CONFLICT" } }, { status: 409 });
  const assets = version.assets as unknown as { project_id: string | null; style_id: string | null };
  const isStyleAsset = Boolean(assets.style_id);
  let workspaceId: string;
  let maskStoragePath: string;
  let maskInsert: Record<string, unknown>;
  if (isStyleAsset) {
    const { data: style } = await supabase.from("styles").select("id, workspace_id").eq("id", assets.style_id).single();
    if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND" } }, { status: 404 });
    workspaceId = style.workspace_id;
    const maskId = crypto.randomUUID();
    maskStoragePath = `${workspaceId}/styles/${assets.style_id}/job-inputs/${maskId}/mask.png`;
    maskInsert = { id: maskId, workspace_id: workspaceId, style_id: assets.style_id, project_id: null, asset_id: assetId, parent_version_id: parsed.data.parentVersionId, storage_path: maskStoragePath, mime_type: "image/png", width: metadata.width, height: metadata.height, byte_size: bytes.byteLength, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  } else {
    if (!assets.project_id) return NextResponse.json({ error: { code: "INVALID_REQUEST" } }, { status: 400 });
    const { data: project } = await supabase.from("projects").select("id, workspace_id").eq("id", assets.project_id).single();
    if (!project) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    workspaceId = project.workspace_id;
    const maskId = crypto.randomUUID();
    maskStoragePath = `${workspaceId}/${assets.project_id}/job-inputs/${maskId}/mask.png`;
    maskInsert = { id: maskId, workspace_id: workspaceId, project_id: assets.project_id, style_id: null, asset_id: assetId, parent_version_id: parsed.data.parentVersionId, storage_path: maskStoragePath, mime_type: "image/png", width: metadata.width, height: metadata.height, byte_size: bytes.byteLength, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  }
  const service = getServiceClient();
  const { error: uploadError } = await service.storage.from(STORAGE_BUCKET).upload(maskStoragePath, bytes, { contentType: "image/png", upsert: false });
  if (uploadError) return NextResponse.json({ error: { code: "FILE_UNAVAILABLE" } }, { status: 500 });
  const { error } = await service.from("ai_job_inputs").insert(maskInsert);
  if (error) {
    await service.storage.from(STORAGE_BUCKET).remove([maskStoragePath]);
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: error.message } }, { status: 400 });
  }
  return NextResponse.json({ maskId: (maskInsert as { id: string }).id }, { status: 201 });
}
