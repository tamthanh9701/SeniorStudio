import type { SupabaseClient } from "@supabase/supabase-js";
import { STORAGE_BUCKET } from "../../db/schema";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MiB
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

export type ErrorCode =
  | "FILE_UNAVAILABLE"
  | "UNSUPPORTED_IMAGE"
  | "FILE_TOO_LARGE"
  | "NOT_FOUND"
  | "VERSION_CONFLICT";

export class AssetError extends Error {
  constructor(
    public code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AssetError";
  }
}

type ImageSource = "chatgpt" | "web_openai" | "upload" | "flattened";

type IngestedImage = {
  asset: { id: string; project_id: string; name: string; current_version_id: string | null };
  version: { id: string; storage_path: string };
};

async function validateImageBytes(bytes: Uint8Array): Promise<{
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
  width: number;
  height: number;
}> {
  if (bytes.byteLength > MAX_FILE_SIZE) {
    throw new AssetError("FILE_TOO_LARGE", "File exceeds 50 MiB limit");
  }

  try {
    const sharp = (await import("sharp")).default;
    const image = sharp(Buffer.from(bytes), { failOn: "error" });
    const metadata = await image.metadata();
    const format = metadata.format;
    const mimeType = format === "png" ? "image/png"
      : format === "jpeg" ? "image/jpeg"
      : format === "webp" ? "image/webp"
      : null;
    if (!mimeType || !metadata.width || !metadata.height) {
      throw new Error("unsupported image");
    }
    const extension: "png" | "jpg" | "webp" = format === "jpeg" ? "jpg" : format === "png" ? "png" : "webp";
    return {
      bytes,
      mimeType,
      extension,
      width: metadata.width,
      height: metadata.height,
    };
  } catch {
    throw new AssetError("UNSUPPORTED_IMAGE", "Image must be a decoded PNG, JPEG, or WebP file");
  }
}

export async function ingestImageBytes(params: {
  client: SupabaseClient;
  workspaceId: string;
  projectId: string;
  assetId?: string;
  parentVersionId?: string;
  bytes: Uint8Array | ArrayBuffer;
  source: ImageSource;
  name?: string;
  prompt?: string;
  providerResponseId?: string;
  metadata?: Record<string, unknown>;
}): Promise<IngestedImage> {
  const assetId = params.assetId ?? crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const decoded = await validateImageBytes(
    params.bytes instanceof Uint8Array ? params.bytes : new Uint8Array(params.bytes)
  );
  const storagePath = `${params.workspaceId}/${params.projectId}/${assetId}/${versionId}/source.${decoded.extension}`;
  const assetName = params.name?.trim() || params.prompt?.trim().slice(0, 100) || "Untitled";

  const { error: uploadError } = await params.client.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, decoded.bytes, {
      contentType: decoded.mimeType,
      upsert: false,
    });
  if (uploadError) {
    throw new AssetError("FILE_UNAVAILABLE", "Failed to upload to storage");
  }

  const { error: commitError } = await params.client.rpc("commit_asset_version", {
    p_workspace_id: params.workspaceId,
    p_project_id: params.projectId,
    p_asset_id: assetId,
    p_version_id: versionId,
    p_parent_version_id: params.parentVersionId ?? null,
    p_asset_name: assetName,
    p_kind: params.source === "upload" ? "uploaded" : "generated",
    p_source: params.source,
    p_storage_path: storagePath,
    p_mime_type: decoded.mimeType,
    p_width: decoded.width,
    p_height: decoded.height,
    p_byte_size: decoded.bytes.byteLength,
    p_prompt: params.prompt ?? null,
    p_provider_response_id: params.providerResponseId ?? null,
    p_metadata: params.metadata ?? {},
  });

  if (commitError) {
    await params.client.storage.from(STORAGE_BUCKET).remove([storagePath]);
    if (commitError.message.includes("VERSION_CONFLICT")) {
      throw new AssetError("VERSION_CONFLICT", "Parent version does not belong to the asset");
    }
    if (commitError.message.includes("NOT_FOUND")) {
      throw new AssetError("NOT_FOUND", "Project or asset was not found");
    }
    throw commitError;
  }

  return {
    asset: { id: assetId, project_id: params.projectId, name: assetName, current_version_id: versionId },
    version: { id: versionId, storage_path: storagePath },
  };
}

export async function ingestImage(params: {
  client: SupabaseClient;
  workspaceId: string;
  projectId: string;
  assetId?: string;
  parentVersionId?: string;
  fileUrl: string;
  source: ImageSource;
  name?: string;
  prompt?: string;
  providerResponseId?: string;
  metadata?: Record<string, unknown>;
}): Promise<IngestedImage> {
  if (!params.fileUrl.startsWith("https://")) {
    throw new AssetError("FILE_UNAVAILABLE", "File URL must use HTTPS");
  }

  const response = await fetch(params.fileUrl);
  if (!response.ok) {
    throw new AssetError("FILE_UNAVAILABLE", "Failed to download file");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_FILE_SIZE) {
    throw new AssetError("FILE_TOO_LARGE", "File exceeds 50 MiB limit");
  }

  return ingestImageBytes({
    ...params,
    bytes: await response.arrayBuffer(),
  });
}

export async function getSignedUrl(
  client: SupabaseClient,
  storagePath: string
): Promise<string> {
  const { data, error } = await client.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, 600); // 10 minutes

  if (error) throw error;
  return data.signedUrl;
}
