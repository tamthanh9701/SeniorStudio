import { NextResponse } from "next/server";
import { createClient, getServiceClient } from "@/supabase/server";
import { STORAGE_BUCKET } from "@/db/schema";
import { resolveUserWorkspaceId } from "@/lib/ai/models";

export const maxDuration = 60;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MEGAPIXELS = 40_000_000;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function GET(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const workspaceId = await resolveUserWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });

  const service = getServiceClient();
  const { data: style } = await service.from("styles").select("id").eq("id", styleId).eq("workspace_id", workspaceId).single();
  if (!style) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const searchParams = new URL(request.url).searchParams;
  const rawLimit = Number(searchParams.get("limit") ?? 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20));
  const rawPage = Number(searchParams.get("page") ?? 1);
  const page = Math.max(1, Number.isFinite(rawPage) ? Math.floor(rawPage) : 1);
  const offset = (page - 1) * limit;
  const { data: assets, error } = await service
    .from("assets")
    .select("id, name, kind, current_version_id, created_at")
    .eq("style_id", styleId)
    .eq("kind", "uploaded")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit);
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: error.message } }, { status: 500 });

  const hasMore = (assets ?? []).length > limit;
  const sources = await Promise.all((assets ?? []).slice(0, limit).map(async (asset) => {
    const versionId = asset.current_version_id;
    if (!versionId) return { id: asset.id, name: asset.name, versionId: null, signedUrl: null, createdAt: asset.created_at };
    const { data: version } = await service.from("asset_versions").select("storage_path").eq("id", versionId).single();
    if (!version) return { id: asset.id, name: asset.name, versionId, signedUrl: null, createdAt: asset.created_at };
    const { data: signed } = await service.storage.from(STORAGE_BUCKET).createSignedUrl(version.storage_path, 3600);
    return { id: asset.id, name: asset.name, versionId, signedUrl: signed?.signedUrl ?? null, createdAt: asset.created_at };
  }));
  return NextResponse.json({ sources, pagination: { page, limit, hasMore, nextPage: hasMore ? page + 1 : null } });
}

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const workspaceId = await resolveUserWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });

  const service = getServiceClient();
  const { data: style } = await service.from("styles").select("id, workspace_id").eq("id", styleId).eq("workspace_id", workspaceId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file !== "object" || typeof (file as File).arrayBuffer !== "function") {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "No file uploaded" } }, { status: 400 });
  }
  const f = file as File;
  if (!ALLOWED_MIME.has(f.type.split(";")[0].trim())) {
    return NextResponse.json({ error: { code: "UNSUPPORTED_IMAGE_TYPE", message: `Unsupported image type ${f.type || "unknown"}` } }, { status: 415 });
  }
  if (f.size <= 0 || f.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: { code: "REFERENCE_TOO_LARGE", message: "Source must be 1 byte to 5 MB" } }, { status: 413 });
  }

  const bytes = new Uint8Array(await f.arrayBuffer());
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(Buffer.from(bytes), { failOn: "error" }).metadata().catch(() => null);
  if (!metadata?.format || !metadata.width || !metadata.height) {
    return NextResponse.json({ error: { code: "UNSUPPORTED_IMAGE_TYPE", message: "Could not decode image" } }, { status: 415 });
  }
  if (metadata.width * metadata.height > MAX_MEGAPIXELS) {
    return NextResponse.json({ error: { code: "REFERENCE_TOO_LARGE", message: "Image exceeds 40 megapixels" } }, { status: 413 });
  }
  const expectedFormat = f.type.includes("jpeg") ? "jpeg" : f.type.includes("webp") ? "webp" : "png";
  if (metadata.format !== expectedFormat) {
    return NextResponse.json({ error: { code: "UNSUPPORTED_IMAGE_TYPE", message: "Declared type does not match file contents" } }, { status: 415 });
  }

  const ext = metadata.format === "jpeg" ? "jpg" : metadata.format;
  const mime = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
  const assetId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const storagePath = `${style.workspace_id}/styles/${styleId}/sources/${assetId}/${versionId}/source.${ext}`;

  const { error: uploadError } = await service.storage
    .from(STORAGE_BUCKET).upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (uploadError) return NextResponse.json({ error: { code: "FILE_UNAVAILABLE", message: uploadError.message } }, { status: 500 });

  try {
    const { error: rpcError } = await service.rpc("commit_style_source", {
      p_workspace_id: style.workspace_id,
      p_style_id: styleId,
      p_asset_id: assetId,
      p_version_id: versionId,
      p_name: f.name || "Source",
      p_storage_path: storagePath,
      p_mime_type: mime,
      p_width: metadata.width,
      p_height: metadata.height,
      p_byte_size: bytes.byteLength,
    });
    if (rpcError) {
      await service.storage.from(STORAGE_BUCKET).remove([storagePath]);
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: rpcError.message } }, { status: 500 });
    }
    const { data: signed } = await service.storage.from(STORAGE_BUCKET).createSignedUrl(storagePath, 3600);
    return NextResponse.json({ assetId, versionId, signedUrl: signed?.signedUrl ?? null }, { status: 201 });
  } catch (error) {
    await service.storage.from(STORAGE_BUCKET).remove([storagePath]);
    const message = error instanceof Error ? error.message : "Failed to persist source";
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message } }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const workspaceId = await resolveUserWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const sourceId = searchParams.get("sourceId");
  if (!sourceId) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "sourceId required" } }, { status: 400 });

  const service = getServiceClient();
  const { data: style } = await service.from("styles").select("id, workspace_id").eq("id", styleId).eq("workspace_id", workspaceId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const { data: asset } = await service.from("assets").select("id, current_version_id").eq("id", sourceId).eq("style_id", styleId).maybeSingle();
  if (!asset) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Source not found" } }, { status: 404 });

  // Check active jobs referencing this source
  const { data: activeJobs } = await service.from("ai_jobs").select("id").eq("source_version_id", asset.current_version_id).not("status", "in", "(succeeded,failed,canceled)").limit(1);
  if (activeJobs && activeJobs.length > 0) {
    return NextResponse.json({ error: { code: "SOURCE_IN_USE", message: "Source is referenced by an active job" } }, { status: 409 });
  }

  try {
    // DB delete first — if this fails, storage stays intact (no orphan risk is worse than data loss).
    const { error: delError } = await service.from("assets").delete().eq("id", sourceId);
    if (delError) return NextResponse.json({ error: { code: "DELETE_FAILED", message: delError.message } }, { status: 500 });

    // Storage remove is best-effort after confirmed DB delete.
    if (asset.current_version_id) {
      const { data: version } = await service.from("asset_versions").select("storage_path").eq("id", asset.current_version_id).maybeSingle();
      if (version?.storage_path) {
        const { error: storageError } = await service.storage.from(STORAGE_BUCKET).remove([version.storage_path]);
        if (storageError) console.error(`source storage remove failed path=${version.storage_path}: ${storageError.message}`);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: { code: "DELETE_FAILED", message } }, { status: 500 });
  }
}
