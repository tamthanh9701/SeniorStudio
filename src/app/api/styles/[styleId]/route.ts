// Style detail routes: full read, name/status patch (with activation gate),
// delete with best-effort storage cleanup.
import { NextResponse } from "next/server";
import { z } from "zod";
import { STORAGE_BUCKET } from "@/db/schema";
import { createClient, getServiceClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";

const PatchStyleSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), status: z.enum(["draft", "active"]).optional() })
  .strict();

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const { data: style } = await supabase.from("styles").select("*").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });
  const { data: references } = await supabase
    .from("style_references")
    .select("id, storage_path, mime_type, byte_size, width, height, content_hash, created_at")
    .eq("style_id", styleId)
    .order("created_at");
  const referencesWithUrls = await Promise.all((references ?? []).map(async (reference) => {
    const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(reference.storage_path, 600);
    const { storage_path: _storagePath, ...metadata } = reference;
    return { ...metadata, signed_url: data?.signedUrl ?? null };
  }));
  return NextResponse.json({ style: { ...style, references: referencesWithUrls } });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = PatchStyleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Only name and status may be updated" } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("id, status, schema, fingerprint, invariant_contract, analysis_meta").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  // Activation gate: a style needs a real analysis behind it before generate can use it.
  const meta = (style.analysis_meta ?? {}) as Record<string, unknown>;
  const analyzed = Boolean(meta.analyzedAt) && style.schema && Object.keys(style.schema as object).length > 0 && Boolean(style.fingerprint) && Boolean(style.invariant_contract);
  if (parsed.data.status === "active" && !analyzed) {
    return NextResponse.json({ error: { code: "STYLE_NOT_READY", message: "Run analysis before activating this style" } }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("styles")
    .update({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    })
    .eq("id", styleId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: { code: "UPDATE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ style: updated });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const { data: style } = await supabase.from("styles").select("id, workspace_id").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const { data: references } = await supabase.from("style_references").select("storage_path").eq("style_id", styleId);
  const { error } = await supabase.from("styles").delete().eq("id", styleId);
  if (error) return NextResponse.json({ error: { code: "DELETE_FAILED", message: error.message } }, { status: 500 });

  // Best-effort storage cleanup; orphans are logged, never surfaced to the client.
  if (references?.length) {
    const { error: storageError } = await getServiceClient().storage
      .from(STORAGE_BUCKET)
      .remove(references.map((reference) => reference.storage_path));
    if (storageError) {
      console.error(`style storage orphan prefix=${style.workspace_id}/styles/${styleId}/: ${storageError.message}`);
    }
  }
  return NextResponse.json({ ok: true });
}
