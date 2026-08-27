import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "../../env";
import {
  ASSETS_TABLE,
  ASSET_VERSIONS_TABLE,
  GENERATION_RUNS_TABLE,
  STORAGE_BUCKET,
} from "../../db/schema";

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

export async function ingestImage(params: {
  client: SupabaseClient;
  workspaceId: string;
  projectId: string;
  assetId?: string;
  parentVersionId?: string;
  fileUrl: string;
  source: "chatgpt" | "web_openai" | "upload";
  prompt?: string;
  providerResponseId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{
  asset: { id: string; project_id: string; name: string; current_version_id: string | null };
  version: { id: string; storage_path: string };
}> {
  const {
    client,
    workspaceId,
    projectId,
    assetId,
    parentVersionId,
    fileUrl,
    source,
    prompt,
    providerResponseId,
    metadata,
  } = params;

  // Validate HTTPS
  if (!fileUrl.startsWith("https://")) {
    throw new AssetError("FILE_UNAVAILABLE", "File URL must use HTTPS");
  }

  // Download and validate file
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new AssetError("FILE_UNAVAILABLE", "Failed to download file");
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_FILE_SIZE) {
    throw new AssetError("FILE_TOO_LARGE", "File exceeds 50 MiB limit");
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw new AssetError("FILE_TOO_LARGE", "File exceeds 50 MiB limit");
  }

  const contentType = response.headers.get("content-type");
  if (!contentType || !ALLOWED_MIME_TYPES.includes(contentType)) {
    throw new AssetError("UNSUPPORTED_IMAGE", "Unsupported image type");
  }

  // Verify image dimensions using sharp
  const sharp = (await import("sharp")).default;
  const imageMetadata = await sharp(Buffer.from(buffer)).metadata();
  if (!imageMetadata.width || !imageMetadata.height) {
    throw new AssetError("UNSUPPORTED_IMAGE", "Invalid image dimensions");
  }

  // Determine file extension
  const ext = contentType === "image/png" ? "png" : 
              contentType === "image/jpeg" ? "jpg" : "webp";

  // Generate storage path
  const versionId = crypto.randomUUID();
  const storagePath = `${workspaceId}/${projectId}/${assetId || "new"}/${versionId}/source.${ext}`;

  // Upload to storage
  const { error: uploadError } = await client.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType,
      upsert: false,
    });

  if (uploadError) {
    throw new AssetError("FILE_UNAVAILABLE", "Failed to upload to storage");
  }

  // Database transaction
  try {
    // Create or update asset
    let finalAssetId = assetId;
    if (!finalAssetId) {
      const { data: asset, error: assetError } = await client
        .from(ASSETS_TABLE)
        .insert({
          project_id: projectId,
          name: prompt?.slice(0, 100) || "Untitled",
          kind: source === "upload" ? "uploaded" : "generated",
        })
        .select()
        .single();

      if (assetError) throw assetError;
      finalAssetId = asset.id;
    }

    // Create version
    const { error: versionError } = await client
      .from(ASSET_VERSIONS_TABLE)
      .insert({
        asset_id: finalAssetId,
        parent_version_id: parentVersionId,
        source,
        storage_path: storagePath,
        mime_type: contentType,
        width: imageMetadata.width,
        height: imageMetadata.height,
        byte_size: buffer.byteLength,
        prompt,
        provider_response_id: providerResponseId,
        metadata: metadata || {},
      });

    if (versionError) throw versionError;

    // Update asset current_version_id
    const { error: updateError } = await client
      .from(ASSETS_TABLE)
      .update({ current_version_id: versionId, updated_at: new Date().toISOString() })
      .eq("id", finalAssetId);

    if (updateError) throw updateError;

    return {
      asset: { id: finalAssetId!, project_id: projectId, name: prompt?.slice(0, 100) || "Untitled", current_version_id: versionId },
      version: { id: versionId, storage_path: storagePath },
    };
  } catch (error) {
    // Cleanup storage on database error
    await client.storage.from(STORAGE_BUCKET).remove([storagePath]);
    throw error;
  }
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
