// Upload plumbing shared by the Game UI input and extraction routes.  A
// wireframe, a matte and an extracted PNG are the same risk: bytes that must
// become a classified, style-owned asset version.  The bookkeeping row written
// before the object exists is what makes an unknown outcome recoverable, so a
// retry never deletes bytes the database already committed.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp, { type Metadata } from "sharp";

import { STORAGE_BUCKET } from "@/db/schema";
import { getOwnedAssetVersion, signOwnedUrl } from "@/lib/assets/ownership";
import { GameUiError } from "./errors";

export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000;
/** The input tables reject a larger edge, and a provider downscales it anyway. */
export const MAX_INPUT_EDGE = 20_000;
export const INPUT_SIGNED_URL_SECONDS = 3600;

const MIME_BY_FORMAT: Record<string, { mimeType: string; extension: string }> = {
  png: { mimeType: "image/png", extension: "png" },
  jpeg: { mimeType: "image/jpeg", extension: "jpg" },
  webp: { mimeType: "image/webp", extension: "webp" },
};

export type ImageUpload = {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  name: string;
  /** A matte is a canvas of alpha values, so it must carry a real alpha channel. */
  hasAlpha: boolean;
  /**
   * The already-parsed body.  A request body can only be read once, so a route
   * that also needs a sibling field (the matte's `elementSetId`) reads it here
   * instead of parsing the multipart payload twice.
   */
  form: FormData;
};

export type ImageUploadLimits = {
  maxBytes?: number;
  allowedMime: readonly string[];
};

/**
 * EXIF orientation is baked into the stored bytes: the recorded dimensions, the
 * content hash and every later decode (provider input, extraction crop) then
 * describe the same pixels, which a raw `width`/`height` read of a rotated file
 * would not.
 */
async function normalizeOrientation(
  bytes: Uint8Array,
  probe: Metadata,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const width = probe.width ?? 0;
  const height = probe.height ?? 0;
  // Orientation 1 (or absent) already means the stored pixels are the displayed
  // ones, so the original bytes survive untouched.
  if (!probe.orientation || probe.orientation === 1 || !height || !width) return { bytes, width, height };

  const pipeline = sharp(bytes, { failOn: "error" }).rotate();
  if (probe.format === "jpeg") pipeline.jpeg({ quality: 95 });
  else if (probe.format === "webp") pipeline.webp({ quality: 95 });
  else pipeline.png({ compressionLevel: 9 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { bytes: new Uint8Array(data), width: info.width, height: info.height };
}

export async function readImageUpload(request: Request, limits: ImageUploadLimits): Promise<ImageUpload> {
  const maxBytes = limits.maxBytes ?? MAX_INPUT_BYTES;
  const form = await request.formData().catch(() => null);
  if (!form) throw new GameUiError("INVALID_REQUEST", "Expected a multipart form upload");

  const uploaded = form.get("file");
  if (!uploaded || typeof uploaded !== "object" || typeof (uploaded as File).arrayBuffer !== "function") {
    throw new GameUiError("INVALID_REQUEST", "No file uploaded");
  }
  const file = uploaded as File;
  if (file.size <= 0 || file.size > maxBytes) {
    throw new GameUiError("REFERENCE_TOO_LARGE", `Image must be 1 byte to ${Math.floor(maxBytes / (1024 * 1024))} MB`);
  }

  const declaredMime = (file.type ?? "").split(";")[0].trim().toLowerCase();
  if (!limits.allowedMime.includes(declaredMime)) {
    throw new GameUiError("UNSUPPORTED_IMAGE_TYPE", `Unsupported image type ${declaredMime || "unknown"}`);
  }

  const original = new Uint8Array(await file.arrayBuffer());
  const probe = await sharp(original, { failOn: "error" }).metadata().catch(() => null);
  if (!probe?.format || !probe.width || !probe.height) {
    throw new GameUiError("UNSUPPORTED_IMAGE_TYPE", "Could not decode image");
  }
  const format = MIME_BY_FORMAT[probe.format];
  if (!format || !limits.allowedMime.includes(format.mimeType)) {
    throw new GameUiError("UNSUPPORTED_IMAGE_TYPE", `Unsupported image format ${probe.format}`);
  }
  // A declared type that disagrees with the decoded bytes is not a preference to
  // normalise: the stored mime, the extension and every later decode must agree.
  if (format.mimeType !== declaredMime) {
    throw new GameUiError(
      "UNSUPPORTED_IMAGE_TYPE",
      `Declared type ${declaredMime} does not match the ${probe.format} contents`,
    );
  }

  const normalized = await normalizeOrientation(original, probe);
  if (normalized.width * normalized.height > MAX_INPUT_PIXELS) {
    throw new GameUiError("REFERENCE_TOO_LARGE", "Image exceeds 40 megapixels");
  }
  if (normalized.width > MAX_INPUT_EDGE || normalized.height > MAX_INPUT_EDGE) {
    throw new GameUiError("INVALID_REQUEST", `Image is larger than the ${MAX_INPUT_EDGE} pixel input limit`);
  }

  return {
    bytes: normalized.bytes,
    mimeType: format.mimeType,
    extension: format.extension,
    width: normalized.width,
    height: normalized.height,
    name: file.name || "Game UI input",
    hasAlpha: probe.hasAlpha === true,
    form,
  };
}

/** Lowercase hex SHA-256, the form every content hash in this module is stored in. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type GameUiUploadOperation = "wireframe" | "element_matte" | "element_output";

/**
 * Pending row → object upload → commit.
 *
 * The bookkeeping row is written before the object exists, so a commit whose
 * outcome is unknown is resolved by reading back the row it would have created:
 * the bytes survive whenever that row exists, and are removed only when the
 * database proves nothing was committed.
 */
export async function writeGameUiObject<T extends object>(params: {
  service: SupabaseClient;
  workspaceId: string;
  styleId: string;
  operation: GameUiUploadOperation;
  assetId: string;
  versionId: string;
  storagePath: string;
  inputId: string | null;
  outputId: string | null;
  bytes: Uint8Array;
  mimeType: string;
  commit: () => Promise<T | null>;
  readCommitted: () => Promise<T | null>;
}): Promise<T> {
  const { service, workspaceId, styleId, operation, assetId, versionId, storagePath, inputId, outputId, bytes, mimeType } = params;
  const uploadId = crypto.randomUUID();

  const { error: beginError } = await service.rpc("begin_game_ui_upload", {
    p_upload_id: uploadId,
    p_workspace_id: workspaceId,
    p_style_id: styleId,
    p_asset_id: assetId,
    p_version_id: versionId,
    p_storage_path: storagePath,
    p_operation: operation,
    p_input_id: inputId,
    p_output_id: outputId,
  });
  if (beginError) throw beginError;

  const { error: uploadError } = await service.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
  if (uploadError) {
    // Nothing was written, so the row can go without any reconciliation.
    await service.rpc("finish_game_ui_upload", { p_upload_id: uploadId });
    throw new GameUiError("FILE_UNAVAILABLE", uploadError.message);
  }

  try {
    const committed = await params.commit();
    if (committed) return committed;
    throw new GameUiError("FILE_UNAVAILABLE", "The upload was not committed");
  } catch (commitError) {
    let existing: T | null = null;
    try {
      existing = await params.readCommitted();
    } catch {
      // The database cannot answer, so the bytes stay and the sweep reconciles.
      throw commitError;
    }
    if (existing) return existing;
    const { error: removeError } = await service.storage.from(STORAGE_BUCKET).remove([storagePath]);
    if (!removeError) await service.rpc("finish_game_ui_upload", { p_upload_id: uploadId });
    throw commitError;
  }
}

export type GameUiMatteContext = { render_id: string; element_set_id: string; element_id: string };

/**
 * Registers the uploaded bytes as a style-owned source asset plus the classified
 * input row that gives them meaning.  The route never supplies the asset path:
 * it is derived from ids allocated here, exactly like every other asset version.
 */
export async function uploadGameUiInput(params: {
  service: SupabaseClient;
  workspaceId: string;
  styleId: string;
  kind: "wireframe" | "element_matte";
  file: ImageUpload;
  context: GameUiMatteContext | null;
}): Promise<{ inputId: string; assetId: string; versionId: string; width: number; height: number; signedUrl: string }> {
  const { service, workspaceId, styleId, kind, file, context } = params;
  const inputId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const storagePath = `${workspaceId}/styles/${styleId}/sources/${assetId}/${versionId}/source.${file.extension}`;
  const contentHash = sha256Hex(file.bytes);

  await writeGameUiObject({
    service,
    workspaceId,
    styleId,
    operation: kind,
    assetId,
    versionId,
    storagePath,
    inputId,
    outputId: null,
    bytes: file.bytes,
    mimeType: file.mimeType,
    commit: async () => {
      const { data, error } = await service
        .rpc("register_game_ui_input", {
          p_workspace_id: workspaceId,
          p_style_id: styleId,
          p_asset_id: assetId,
          p_version_id: versionId,
          p_input_id: inputId,
          p_kind: kind,
          p_file: {
            storage_path: storagePath,
            mime_type: file.mimeType,
            content_hash: contentHash,
            name: file.name,
            byte_size: file.bytes.byteLength,
            width: file.width,
            height: file.height,
          },
          p_context: context ?? {},
        })
        .single();
      if (error) throw error;
      return (data as Record<string, unknown> | null) ?? null;
    },
    readCommitted: async () => {
      const { data } = await service.from("game_ui_inputs").select("id, version_id").eq("id", inputId).maybeSingle();
      return (data as Record<string, unknown> | null) ?? null;
    },
  });

  // Ownership is proven against the ids written above before the URL is minted:
  // the returned link is a capability, not a convenience.
  const owned = await getOwnedAssetVersion(service, workspaceId, assetId, versionId);
  return {
    inputId,
    assetId,
    versionId,
    width: file.width,
    height: file.height,
    signedUrl: await signOwnedUrl(service, owned.owned, INPUT_SIGNED_URL_SECONDS),
  };
}
