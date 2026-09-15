// Style detail routes: full read, name/status patch (with activation gate),
// delete with best-effort storage cleanup.
import { NextResponse } from "next/server";
import { lintAndFixStyleSchema } from "@/lib/style/linter";
import { buildStyleInvariantContract, critiqueStyleSchema } from "@/lib/style/invariant-contract";
import { commitStyleSchemaMutation, updateStyleFields, getSchemaVersions } from "@/lib/style/schema-versions";
import type { PromptSchema } from "@/lib/style/prompt-schema";
import { scoreStyleOperability } from "@/lib/style/operability-scorer";
import { z } from "zod";
import { STORAGE_BUCKET } from "@/db/schema";
import { createClient, getServiceClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";
const PatchStyleSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), status: z.enum(["draft", "active"]).optional(), libraryId: z.string().uuid().nullable().optional(), schema: z.record(z.string(), z.unknown()).optional(), expectedUpdatedAt: z.string().min(1).optional() })
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
    .is("retired_at", null)
    .order("created_at");
  const referencesWithUrls = await Promise.all((references ?? []).map(async (reference) => {
    const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(reference.storage_path, 600);
    const { storage_path: _storagePath, ...metadata } = reference;
    return { ...metadata, signed_url: data?.signedUrl ?? null };
  }));
  const schemaVersions = await getSchemaVersions(supabase, styleId);
  return NextResponse.json({ style: { ...style, references: referencesWithUrls, schemaVersions } });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = PatchStyleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Only name, status, libraryId, and schema may be updated" } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("id, status, schema, fingerprint, invariant_contract, analysis_meta, operability, updated_at").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  // Confirming a style publishes the analysed candidate as the durable
  // definition used for generation.  It is a distinct operation from editing
  // the candidate, so both in one request is rejected rather than guessed.
  if (parsed.data.status === "active") {
    if (parsed.data.schema) {
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Save the schema change, review it, then confirm the style" } }, { status: 400 });
    }
    if (!parsed.data.expectedUpdatedAt) {
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "expectedUpdatedAt is required to confirm a style" } }, { status: 400 });
    }
    const { data: confirmed, error: confirmError } = await supabase
      .rpc("confirm_style_definition", { p_style_id: styleId, p_expected_updated_at: parsed.data.expectedUpdatedAt })
      .single();
    if (confirmError) {
      const message = confirmError.message;
      if (message.includes("STYLE_VERSION_CONFLICT")) {
        return NextResponse.json({ error: { code: "STYLE_VERSION_CONFLICT", message: "Style was modified since you started editing" } }, { status: 409 });
      }
      if (message.includes("STYLE_ANALYSIS_STALE")) {
        return NextResponse.json({ error: { code: "STYLE_ANALYSIS_STALE", message: "References changed since the analysis; analyze them again" } }, { status: 409 });
      }
      if (message.includes("STYLE_NOT_READY")) {
        return NextResponse.json({ error: { code: "STYLE_NOT_READY", message: "Add references and run analysis before confirming this style" } }, { status: 409 });
      }
      if (message.includes("STYLE_NOT_FOUND")) {
        return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });
      }
      return NextResponse.json({ error: { code: "UPDATE_FAILED", message } }, { status: 500 });
    }
    let afterConfirm = confirmed as Record<string, unknown>;
    if (parsed.data.name !== undefined || parsed.data.libraryId !== undefined) {
      const { data: renamed, error: renameError } = await supabase.rpc("update_style_fields", {
        p_style_id: styleId,
        p_expected_updated_at: afterConfirm.updated_at,
        p_patch: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.libraryId !== undefined ? { library_id: parsed.data.libraryId } : {}),
        },
      });
      if (renameError) return NextResponse.json({ error: { code: "UPDATE_FAILED", message: renameError.message } }, { status: 500 });
      afterConfirm = renamed as Record<string, unknown>;
    }
    return NextResponse.json({ style: afterConfirm });
  }

  let schemaUpdate: Record<string, unknown> = {};
  let schemaQualityScore: number | undefined;
  if (parsed.data.schema) {
    const lintResult = lintAndFixStyleSchema(parsed.data.schema as unknown as PromptSchema);
    const fingerprint = lintResult.fingerprint;
    const contract = buildStyleInvariantContract({ schema: lintResult.schema, fingerprint });
    const quality = critiqueStyleSchema({ schema: lintResult.schema, contract });
    schemaQualityScore = quality.overall;
    const operability = scoreStyleOperability({ promptSchema: lintResult.schema as unknown as Record<string, unknown> });
    schemaUpdate = { schema: lintResult.schema, fingerprint, invariant_contract: contract, operability };
  }

  let updated;
  try {
    if (parsed.data.schema) {
      updated = await commitStyleSchemaMutation(supabase, {
        styleId,
        expectedUpdatedAt: style.updated_at,
        source: "manual",
        schema: schemaUpdate.schema as Record<string, unknown>,
        fingerprint: schemaUpdate.fingerprint as Record<string, unknown>,
        invariantContract: schemaUpdate.invariant_contract as Record<string, unknown>,
        styleFields: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
          ...(parsed.data.libraryId !== undefined ? { library_id: parsed.data.libraryId } : {}),
          ...(schemaUpdate.operability ? { operability: schemaUpdate.operability } : {}),
        },
        metadata: { qualityScore: schemaQualityScore },
      });
    } else {
      updated = await updateStyleFields(supabase, {
        styleId,
        expectedUpdatedAt: style.updated_at,
        name: parsed.data.name,
        status: parsed.data.status,
        libraryId: parsed.data.libraryId,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("STYLE_VERSION_CONFLICT")) {
      return NextResponse.json({ error: { code: "STYLE_VERSION_CONFLICT", message: "Style was modified since you started editing" } }, { status: 409 });
    }
    if (message.includes("INVALID_LIBRARY")) {
      return NextResponse.json({ error: { code: "INVALID_LIBRARY", message: "Library does not belong to this workspace" } }, { status: 400 });
    }
    return NextResponse.json({ error: { code: "UPDATE_FAILED", message } }, { status: 500 });
  }
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
  // Validate path ownership before privileged storage cleanup.
  const mismatched = (references ?? []).filter((reference) => !reference.storage_path.startsWith(`${style.workspace_id}/`));
  if (mismatched.length) {
    console.error(`style storage_path mismatch style_ws=${style.workspace_id} paths=${mismatched.map((reference) => reference.storage_path).join(",")}`);
    return NextResponse.json({ error: { code: "DELETE_FAILED", message: "Reference path ownership mismatch" } }, { status: 500 });
  }
  try {
    // DB delete first — fail-closed on row error.
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: { code: "DELETE_FAILED", message } }, { status: 500 });
  }
}
