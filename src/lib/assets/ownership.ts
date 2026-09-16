import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { STORAGE_BUCKET } from "@/db/schema";

/** Runtime-private brand: unlike `declare const`, this exists when code executes. */
const __ownedBrand: unique symbol = Symbol("owned-storage-object");
export type OwnedStorageObject = {
  readonly workspaceId: string;
  readonly path: string;
  readonly [__ownedBrand]: true;
};

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const EXT_BY_MIME: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
};

type OwnershipErrorCode = "INVALID_STORAGE_PATH" | "NOT_FOUND";
function ownedError(code: OwnershipErrorCode, message = code): Error {
  return Object.assign(new Error(message), { code });
}
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_RE.test(value); }

/** Reject traversal and encoded separators before any storage operation. */
export function validateStoragePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) throw ownedError("INVALID_STORAGE_PATH");
  if (path.includes("\\") || path.includes("..") || /%2f|%5c/i.test(path)) throw ownedError("INVALID_STORAGE_PATH");
  if (path.startsWith("/") || path.endsWith("/") || path.split("/").some((part) => !part || part === ".")) throw ownedError("INVALID_STORAGE_PATH");
  return path;
}
function brandOwned(workspaceId: string, path: string): OwnedStorageObject {
  validateStoragePath(path);
  if (!isUuid(workspaceId)) throw ownedError("INVALID_STORAGE_PATH");
  return { workspaceId, path, [__ownedBrand]: true };
}
function assertRow(row: Record<string, unknown>, mime: string, expectedExts: string[]): void {
  if (!isUuid(row.id) || !isUuid(row.asset_id as string) || typeof row.storage_path !== "string" || row.mime_type !== mime) throw ownedError("INVALID_STORAGE_PATH");
  const size = row.byte_size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_FILE_SIZE) throw ownedError("INVALID_STORAGE_PATH");
  if (typeof row.width !== "number" || typeof row.height !== "number" || row.width <= 0 || row.height <= 0) throw ownedError("INVALID_STORAGE_PATH");
  const ext = row.storage_path.split(".").pop()?.toLowerCase();
  if (!ext || !expectedExts.includes(ext)) throw ownedError("INVALID_STORAGE_PATH");
}
function assertVersionPath(path: string, workspaceId: string, asset: { id: string; project_id: string | null; style_id: string | null }, versionId: string): string {
  validateStoragePath(path);
  if (!isUuid(asset.id) || asset.project_id !== null && !isUuid(asset.project_id) || asset.style_id !== null && !isUuid(asset.style_id) || (asset.project_id === null) === (asset.style_id === null)) throw ownedError("INVALID_STORAGE_PATH");
  const prefix = asset.project_id
    ? `${workspaceId}/${asset.project_id}/${asset.id}/${versionId}/source.`
    : `${workspaceId}/styles/${asset.style_id}/`;
  if (!/^[0-9a-f-]{36}\/(?:[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/source\.(?:png|jpg|jpeg|webp)|styles\/[0-9a-f-]{36}\/(?:outputs|sources)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/source\.(?:png|jpg|jpeg|webp)|[0-9a-f-]{36}\/job-inputs\/[0-9a-f-]{36}\/mask\.png|styles\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:png|jpg|jpeg|webp))$/i.test(path)) throw ownedError("INVALID_STORAGE_PATH");
  const valid = asset.project_id
    ? new RegExp(`^${workspaceId}/${asset.project_id}/${asset.id}/${versionId}/source\\.(png|jpg|jpeg|webp)$`, "i").test(path)
    : new RegExp(`^${workspaceId}/styles/${asset.style_id}/(?:outputs|sources)/${asset.id}/[0-9a-f-]{36}/source\\.(png|jpg|jpeg|webp)$`, "i").test(path);
  if (!valid || (asset.project_id && !path.startsWith(prefix))) throw ownedError("INVALID_STORAGE_PATH");
  return path;
}

export type OwnedAssetVersion = {
  version: { id: string; asset_id: string; storage_path: string; mime_type: string; width: number; height: number; byte_size: number; source: string; parent_version_id: string | null; prompt: string | null; metadata: Record<string, unknown> };
  asset: { id: string; project_id: string | null; style_id: string | null; current_version_id?: string | null };
  owned: OwnedStorageObject;
};

export async function getOwnedAssetVersion(client: SupabaseClient, workspaceId: string, assetId: string, versionId?: string): Promise<OwnedAssetVersion> {
  if (!isUuid(workspaceId) || !isUuid(assetId) || (versionId && !isUuid(versionId))) throw ownedError("INVALID_STORAGE_PATH");
  const assetResult = await client.from("assets").select("id, project_id, style_id, current_version_id").eq("id", assetId).maybeSingle();
  if (assetResult.error) throw assetResult.error;
  const asset = assetResult.data as OwnedAssetVersion["asset"] | null;
  if (!asset || (asset.project_id === null) === (asset.style_id === null)) throw ownedError("NOT_FOUND");
  if (asset.project_id) {
    const owner = await client.from("projects").select("id").eq("id", asset.project_id).eq("workspace_id", workspaceId).maybeSingle();
    if (owner.error) throw owner.error;
    if (!owner.data) throw ownedError("NOT_FOUND");
  } else {
    const owner = await client.from("styles").select("id").eq("id", asset.style_id).eq("workspace_id", workspaceId).maybeSingle();
    if (owner.error) throw owner.error;
    if (!owner.data) throw ownedError("NOT_FOUND");
  }
  const targetVersionId = versionId ?? asset.current_version_id;
  if (!targetVersionId || !isUuid(targetVersionId)) throw ownedError("NOT_FOUND");
  const { data, error } = await client.from("asset_versions")
    .select("id, asset_id, storage_path, mime_type, width, height, byte_size, source, parent_version_id, prompt, metadata")
    .eq("id", targetVersionId).eq("asset_id", assetId).maybeSingle();
  if (error) throw error;
  if (!data || data.id !== targetVersionId || data.asset_id !== assetId || (!versionId && asset.current_version_id !== data.id) || (data.parent_version_id !== null && !isUuid(data.parent_version_id))) throw ownedError("NOT_FOUND");
  const ext = data.storage_path?.split(".").pop()?.toLowerCase() ?? "";
  const mime = typeof data.mime_type === "string" ? data.mime_type.toLowerCase() : "";
  if (!MIME_BY_EXT[ext] || MIME_BY_EXT[ext] !== mime || !EXT_BY_MIME[mime]) throw ownedError("INVALID_STORAGE_PATH");
  assertRow(data as Record<string, unknown>, mime, EXT_BY_MIME[mime]);
  const path = assertVersionPath(data.storage_path, workspaceId, asset, data.id);
  return { version: { id: data.id, asset_id: data.asset_id, storage_path: path, mime_type: data.mime_type, width: data.width, height: data.height, byte_size: data.byte_size, source: data.source, parent_version_id: data.parent_version_id, prompt: data.prompt, metadata: (data.metadata ?? {}) as Record<string, unknown> }, asset, owned: brandOwned(workspaceId, path) };
}

export type OwnedStyleReference = { reference: { id: string; style_id: string; storage_path: string; mime_type: string; byte_size: number; width: number; height: number; content_hash: string | null; created_at: string }; style: { id: string; workspace_id: string }; owned: OwnedStorageObject };
/**
 * A job's reference, which may be borrowed from another style in the same
 * library. The job style's `library_id` is read once by the caller, so this
 * stays a single query per reference.
 */
const JobReferenceRowSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  storage_path: z.string().min(1),
  mime_type: z.string().min(1),
  byte_size: z.number(),
  width: z.number(),
  height: z.number(),
  content_hash: z.string().nullable(),
  created_at: z.string(),
  styles: z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), library_id: z.string().uuid().nullable() }),
});

export async function getOwnedJobReference(
  client: SupabaseClient,
  params: { workspaceId: string; styleId: string; referenceId: string; libraryId: string | null },
): Promise<OwnedStyleReference> {
  const { workspaceId, styleId, referenceId, libraryId } = params;
  if (!isUuid(workspaceId) || !isUuid(styleId) || !isUuid(referenceId)) throw ownedError("INVALID_STORAGE_PATH");
  const { data, error } = await client
    .from("style_references")
    .select("id, style_id, storage_path, mime_type, byte_size, width, height, content_hash, created_at, styles!inner(id, workspace_id, library_id)")
    .eq("id", referenceId)
    .eq("styles.workspace_id", workspaceId)
    .is("retired_at", null)
    .single();
  if (error) throw error;
  const parsed = JobReferenceRowSchema.safeParse(data);
  if (!parsed.success) throw ownedError("NOT_FOUND");
  const row = parsed.data;
  if (row.id !== referenceId || row.styles.workspace_id !== workspaceId || row.style_id !== row.styles.id) throw ownedError("INVALID_STORAGE_PATH");
  // Borrowing is allowed only between styles of one library.
  if (row.style_id !== styleId && (libraryId === null || row.styles.library_id !== libraryId)) throw ownedError("NOT_FOUND");
  const mime = row.mime_type.toLowerCase();
  const ext = row.storage_path.split(".").pop()?.toLowerCase() ?? "";
  if (!EXT_BY_MIME[mime]?.includes(ext) || !new RegExp(`^${workspaceId}/styles/${row.style_id}/${referenceId}\\.(png|jpg|jpeg|webp)$`, "i").test(row.storage_path)) throw ownedError("INVALID_STORAGE_PATH");
  assertRow({ ...row, asset_id: referenceId }, mime, EXT_BY_MIME[mime]);
  return {
    reference: {
      id: row.id,
      style_id: row.style_id,
      storage_path: row.storage_path,
      mime_type: row.mime_type,
      byte_size: row.byte_size,
      width: row.width,
      height: row.height,
      content_hash: row.content_hash,
      created_at: row.created_at,
    },
    style: { id: row.styles.id, workspace_id: row.styles.workspace_id },
    owned: brandOwned(workspaceId, row.storage_path),
  };
}

export type OwnedJobMask = { mask: { id: string; workspace_id: string; project_id: string | null; style_id: string | null; asset_id: string | null; parent_version_id: string; storage_path: string; mime_type: string; width: number; height: number; byte_size: number; expires_at: string; job_id: string | null }; owned: OwnedStorageObject };
export async function getOwnedJobMask(client: SupabaseClient, workspaceId: string, jobId: string): Promise<OwnedJobMask> {
  if (!isUuid(workspaceId) || !isUuid(jobId)) throw ownedError("INVALID_STORAGE_PATH");
  const { data, error } = await client.from("ai_job_inputs").select("*").eq("job_id", jobId).eq("workspace_id", workspaceId).limit(1).single();
  if (error) throw error;
  if (!data || !isUuid(data.id) || data.workspace_id !== workspaceId || !isUuid(data.parent_version_id) || data.mime_type !== "image/png") throw ownedError("NOT_FOUND");
  const isProject = isUuid(data.project_id) && isUuid(data.asset_id) && data.style_id === null && data.storage_path === `${workspaceId}/${data.project_id}/job-inputs/${data.id}/mask.png`;
  const isStyle = data.project_id === null && data.asset_id === null && isUuid(data.style_id) && data.storage_path === `${workspaceId}/styles/${data.style_id}/job-inputs/${data.id}/mask.png`;
  if (!isProject && !isStyle) throw ownedError("INVALID_STORAGE_PATH");
  assertRow({ ...data, asset_id: data.asset_id ?? data.id } as Record<string, unknown>, "image/png", ["png"]);
  return { mask: data as OwnedJobMask["mask"], owned: brandOwned(workspaceId, data.storage_path) };
}

function assertOwned(value: OwnedStorageObject): void { if (!value || value[__ownedBrand] !== true) throw ownedError("INVALID_STORAGE_PATH"); }
export async function downloadOwnedBytes(client: SupabaseClient, owned: OwnedStorageObject): Promise<{ bytes: Uint8Array; mimeType: string }> {
  assertOwned(owned);
  const { data, error } = await client.storage.from(STORAGE_BUCKET).download(owned.path);
  if (error) throw error;
  if (!data) throw ownedError("NOT_FOUND");
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_SIZE) throw ownedError("INVALID_STORAGE_PATH");
  const ext = owned.path.split(".").pop()?.toLowerCase() ?? "";
  return { bytes, mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream" };
}
export async function signOwnedUrl(client: SupabaseClient, owned: OwnedStorageObject, expiresIn = 3600): Promise<string> {
  assertOwned(owned);
  const { data, error } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(owned.path, expiresIn);
  if (error) throw error;
  if (!data?.signedUrl) throw ownedError("NOT_FOUND");
  return data.signedUrl;
}
export async function removeOwnedObjects(client: SupabaseClient, objects: OwnedStorageObject[]): Promise<void> {
  objects.forEach(assertOwned);
  if (!objects.length) return;
  const { error } = await client.storage.from(STORAGE_BUCKET).remove(objects.map((o) => o.path));
  if (error) throw error;
}
/** Compatibility boundary for callers that already obtained a path from an ownership-filtered row. */
export function ownedStorageObjectFromPath(path: string): OwnedStorageObject {
  const clean = validateStoragePath(path);
  const workspaceId = clean.split("/")[0];
  if (!isUuid(workspaceId)) throw ownedError("INVALID_STORAGE_PATH");
  return brandOwned(workspaceId, clean);
}
export async function getSignedUrl(client: SupabaseClient, storagePath: string, expiresIn = 600): Promise<string | null> {
  try { return await signOwnedUrl(client, ownedStorageObjectFromPath(storagePath), expiresIn); } catch (error) {
    if ((error as { code?: string })?.code === "INVALID_STORAGE_PATH") return null;
    throw error;
  }
}
