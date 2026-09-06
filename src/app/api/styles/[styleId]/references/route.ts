// Reference upload/list for a style. Files are validated (count, size, MIME,
// real magic bytes via sharp), hashed, uploaded with the service client, and
// recorded in style_references.
import { NextResponse } from "next/server";
import sharp, { type Metadata } from "sharp";
import { createClient, getServiceClient } from "@/supabase/server";
import { STORAGE_BUCKET } from "@/db/schema";
import { styleProfilesEnabled } from "@/lib/style/flag";

const MAX_REFERENCES = 8;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MIME = new Set(["image/png", "image/jpeg"]);

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

type ValidatedReference = {
  ok: true;
  declaredMime: string;
  bytes: Uint8Array;
  metadata: Metadata;
  contentHash: string;
};

type InvalidReference = { ok: false; response: NextResponse };

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const { data: style } = await supabase.from("styles").select("id, workspace_id").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const files = form
    ? [...form.getAll("files")].filter(
        (entry): entry is File =>
          typeof entry === "object" && entry !== null && typeof (entry as File).arrayBuffer === "function",
      )
    : [];
  if (!files.length) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "No files uploaded" } }, { status: 400 });
  const validated = await Promise.all(files.map(async (file): Promise<ValidatedReference | InvalidReference> => {
    const declaredMime = (file.type || "").split(";")[0].trim();
    if (!SUPPORTED_MIME.has(declaredMime)) {
      return { ok: false, response: NextResponse.json({ error: { code: "UNSUPPORTED_IMAGE_TYPE", message: `Unsupported image type ${declaredMime || "unknown"}` } }, { status: 415 }) };
    }
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      return { ok: false, response: NextResponse.json({ error: { code: "REFERENCE_TOO_LARGE", message: "Each reference must be 1 byte to 5 MB" } }, { status: 413 }) };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const metadata = await sharp(bytes, { failOn: "error" }).metadata().catch(() => null);
    const expectedFormat = declaredMime === "image/png" ? "png" : "jpeg";
    if (metadata?.format !== expectedFormat) {
      return { ok: false, response: NextResponse.json({ error: { code: "UNSUPPORTED_IMAGE_TYPE", message: "Declared image type does not match file contents" } }, { status: 415 }) };
    }
    const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { ok: true, declaredMime, bytes, metadata, contentHash };
  }));
  const validationFailure = validated.find((item) => !item.ok);
  if (validationFailure && !validationFailure.ok) return validationFailure.response;
  const { count: existing } = await supabase.from("style_references").select("id", { count: "exact", head: true }).eq("style_id", styleId);
  if ((existing ?? 0) + files.length > MAX_REFERENCES) {
    return NextResponse.json({ error: { code: "TOO_MANY_REFERENCES", message: `A style supports at most ${MAX_REFERENCES} reference images` } }, { status: 400 });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: { code: "REFERENCE_TOO_LARGE", message: "Upload exceeds the 20 MB total limit" } }, { status: 413 });
  }

  const service = getServiceClient();
  const inserted: Array<Record<string, unknown>> = [];
  for (const item of validated) {
    if (!item.ok) continue;
    const { declaredMime, bytes, metadata, contentHash } = item;
    const referenceId = crypto.randomUUID();
    const ext = declaredMime === "image/png" ? "png" : "jpg";
    const storagePath = `${style.workspace_id}/styles/${styleId}/${referenceId}.${ext}`;
    const { error: uploadError } = await service.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, bytes, { contentType: declaredMime, upsert: false });
    if (uploadError) return NextResponse.json({ error: { code: "FILE_UNAVAILABLE", message: "Failed to store reference" } }, { status: 500 });

    const { data: reference, error: insertError } = await supabase
      .from("style_references")
      .insert({
        style_id: styleId,
        storage_path: storagePath,
        mime_type: declaredMime,
        byte_size: bytes.byteLength,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        content_hash: contentHash,
      })
      .select("id, mime_type, byte_size, width, height, content_hash, created_at")
      .single();
    if (insertError) {
      await service.storage.from(STORAGE_BUCKET).remove([storagePath]);
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: insertError.message } }, { status: 500 });
    }
    inserted.push(reference);
  }

  return NextResponse.json({ references: inserted }, { status: 201 });
}
