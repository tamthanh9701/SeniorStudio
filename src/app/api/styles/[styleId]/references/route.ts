// Reference upload/list for a style. Files are validated (count, size, MIME,
// real magic bytes via sharp), hashed, uploaded with the service client, and
// recorded in style_references.
import { NextResponse } from "next/server";
import sharp, { type Metadata } from "sharp";
import { createClient, getServiceClient } from "@/supabase/server";
import { STORAGE_BUCKET } from "@/db/schema";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { MAX_REFERENCE_BYTES, MAX_REFERENCE_PIXELS, MAX_STYLE_REFERENCES } from "@/lib/style/reference-limits";
import { mapWithConcurrency } from "@/lib/utils";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const MAX_REFERENCES = MAX_STYLE_REFERENCES;
const MAX_FILE_BYTES = MAX_REFERENCE_BYTES;
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
  const user = await getVerifiedUser(supabase);
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
  if (files.length > MAX_REFERENCES) {
    return NextResponse.json({ error: { code: "TOO_MANY_REFERENCES", message: `A style supports at most ${MAX_REFERENCES} reference images` } }, { status: 400 });
  }
  for (const file of files) {
    const declaredMime = (file.type || "").split(";")[0].trim();
    if (!SUPPORTED_MIME.has(declaredMime)) {
      return NextResponse.json({ error: { code: "UNSUPPORTED_IMAGE_TYPE", message: `Unsupported image type ${declaredMime || "unknown"}` } }, { status: 415 });
    }
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: { code: "REFERENCE_TOO_LARGE", message: "Each reference must be 1 byte to 5 MB" } }, { status: 413 });
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: { code: "REFERENCE_TOO_LARGE", message: "Upload exceeds the 20 MB total limit" } }, { status: 413 });
  }
  const { count: existing } = await supabase.from("style_references").select("id", { count: "exact", head: true }).eq("style_id", styleId).is("retired_at", null);
  if ((existing ?? 0) + files.length > MAX_REFERENCES) {
    return NextResponse.json({ error: { code: "TOO_MANY_REFERENCES", message: `A style supports at most ${MAX_REFERENCES} reference images` } }, { status: 400 });
  }
  const validated = await mapWithConcurrency(files, 2, async (file): Promise<ValidatedReference | InvalidReference> => {
    const declaredMime = (file.type || "").split(";")[0].trim();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const metadata = await sharp(bytes, { failOn: "error" }).metadata().catch(() => null);
    const expectedFormat = declaredMime === "image/png" ? "png" : "jpeg";
    if (metadata?.format !== expectedFormat) {
      return { ok: false, response: NextResponse.json({ error: { code: "UNSUPPORTED_IMAGE_TYPE", message: "Declared image type does not match file contents" } }, { status: 415 }) };
    }
    // File size does not bound decoding cost: a 5 MB PNG can describe hundreds of
    // megapixels. Refusing here means the style never holds an image the analysis
    // step would have to reject later.
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (pixels > MAX_REFERENCE_PIXELS) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: { code: "REFERENCE_TOO_LARGE", message: `Each reference must be at most ${MAX_REFERENCE_PIXELS / 1_000_000} megapixels (this one is ${metadata.width}x${metadata.height})` } },
          { status: 413 },
        ),
      };
    }
    const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { ok: true, declaredMime, bytes, metadata, contentHash };
  });
  const validationFailure = validated.find((item) => !item.ok);
  if (validationFailure && !validationFailure.ok) return validationFailure.response;


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
      .rpc("add_style_reference", {
        p_style_id: styleId,
        p_reference: {
          // The row id is chosen here so it always matches the uploaded object
          // name: the worker resolves a reference by row id and verifies the
          // object is the one named after it.
          id: referenceId,
          storage_path: storagePath,
          mime_type: declaredMime,
          byte_size: bytes.byteLength,
          width: metadata.width ?? null,
          height: metadata.height ?? null,
          content_hash: contentHash,
        },
      })
      .single();
    if (insertError) {
      await service.storage.from(STORAGE_BUCKET).remove([storagePath]);
      const code = insertError.message.includes("TOO_MANY_REFERENCES") ? "TOO_MANY_REFERENCES" : insertError.message.includes("STYLE_NOT_FOUND") ? "STYLE_NOT_FOUND" : "INVALID_REQUEST";
      const status = code === "TOO_MANY_REFERENCES" ? 400 : code === "STYLE_NOT_FOUND" ? 404 : 500;
      return NextResponse.json({ error: { code, message: insertError.message } }, { status });
    }
    inserted.push({
      id: (reference as Record<string, unknown>).id,
      mime_type: (reference as Record<string, unknown>).mime_type,
      byte_size: (reference as Record<string, unknown>).byte_size,
      width: (reference as Record<string, unknown>).width,
      height: (reference as Record<string, unknown>).height,
      content_hash: (reference as Record<string, unknown>).content_hash,
      created_at: (reference as Record<string, unknown>).created_at,
    });
  }

  return NextResponse.json({ references: inserted }, { status: 201 });
}
