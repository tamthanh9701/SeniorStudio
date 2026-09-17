import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  compileStyleGenerationPacket,
  StyleGenerationPacketSchema,
  type StyleGenerationPacket,
  type StyleContentOverrides,
} from "./generation-packet";
import { parseConfirmedDefinition, type ConfirmedStyleDefinition } from "./confirmed-definition";
import { StyleError } from "./errors";
import { resolveImageExecutionPlan, type ExecutionPlan, type ExecutionPlanRequest } from "@/lib/ai/execution-plan";
import { getModelCatalog } from "@/lib/ai/models";
import type { SupportedModelId, SupportedQuality, SupportedSize } from "@/db/ai-jobs";

export type StyleGenerationPlanRequest = ExecutionPlanRequest & {
  styleId: string;
  prompt: string;
  referenceIds: string[];
  /** Extra references borrowed from other styles of this style's library. */
  libraryReferenceIds?: string[];
  sourcePacket?: StyleGenerationPacket | null;
  sourceAssetId?: string | null;
  useCurrentStyle?: boolean;
  sourceOriginalPrompt?: string | null;
};

export type StyleGenerationPlan = {
  plan: ExecutionPlan & {
    styleRevision: string;
    compiledPrompt: string;
    planHash: string;
    warnings: string[];
  };
  packet: StyleGenerationPacket;
};

type OrderedReference = { id: string; content_hash: string | null };

type StyleRow = {
  id: string;
  status: string;
  schema: unknown;
  updated_at: string;
  workspace_id: string;
  library_id: string | null;
  confirmed_definition: unknown;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function hashPlan(packet: StyleGenerationPacket, sourceAssetId: string | null, maskId: string | null, useCurrentStyle: boolean): string {
  const payload = canonicalize({ packet, sourceAssetId, sourceVersionId: packet.source_version_id, maskId, useCurrentStyle });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * The reference set an operation must reuse.
 *
 * A caller that supplies a different set is rejected rather than silently
 * overridden, so a plan always matches the authority it was built from.
 */
function referenceSetFor(
  definition: ConfirmedStyleDefinition,
  requested: readonly string[],
  library: ReadonlyMap<string, OrderedReference>,
): OrderedReference[] {
  const snapshot: OrderedReference[] = definition.reference_snapshot.map((reference) => ({ id: reference.id, content_hash: reference.content_hash }));
  const known = new Map<string, OrderedReference>([
    ...snapshot.map((reference) => [reference.id, reference] as const),
    ...library,
  ]);
  // The style's own references keep definition order; a caller that selects a
  // subset keeps its own order. Library references are always appended, so they
  // can never displace the references that define the style.
  const base = requested.length === 0 ? snapshot : requested.map((id) => known.get(id));
  if (base.some((reference) => reference === undefined)) {
    throw new StyleError("STYLE_CONFLICT", "Requested references do not match the confirmed style definition");
  }
  const seen = new Set(base.map((reference) => reference!.id));
  const ordered = [...base as OrderedReference[]];
  for (const [id, reference] of library) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(reference);
  }
  return ordered;
}

function parseDefinition(style: StyleRow): ConfirmedStyleDefinition | null {
  try {
    return parseConfirmedDefinition(style.confirmed_definition);
  } catch {
    throw new StyleError("STYLE_DEFINITION_INVALID", "The stored style definition is malformed; confirm the style again");
  }
}

export async function resolveStyleGenerationPlan(client: SupabaseClient, request: StyleGenerationPlanRequest, service: SupabaseClient): Promise<StyleGenerationPlan> {
  const prompt = request.prompt?.trim() ?? "";
  const { data: styleData, error: styleError } = await client
    .from("styles")
    .select("id, status, schema, updated_at, workspace_id, library_id, confirmed_definition")
    .eq("id", request.styleId)
    .single();
  if (styleError || !styleData) throw new StyleError("STYLE_NOT_FOUND", "Style not found");
  const style = styleData as unknown as StyleRow;

  if (new Set(request.referenceIds).size !== request.referenceIds.length) {
    throw new StyleError("INVALID_REQUEST", "Duplicate reference selection");
  }

  const sourcePacket = request.sourcePacket ? StyleGenerationPacketSchema.parse(request.sourcePacket) : null;
  const sourceIsAuthority = request.operation === "inpaint" && sourcePacket !== null && sourcePacket.reference_snapshot.length > 0;

  // A variation keeps the source image's content so it changes the rendering,
  // not the subject.  The packet is loaded here rather than trusted from the
  // browser; an unusable one is ignored because the confirmed definition still
  // governs the schema and references.
  let variantPacket: StyleGenerationPacket | null = null;
  if (request.operation === "image_to_image" && request.sourceVersionId) {
    const { data: source, error: sourceError } = await client
      .from("asset_versions")
      .select("style_generation, assets!asset_versions_asset_id_fkey(style_id)")
      .eq("id", request.sourceVersionId)
      .maybeSingle();
    if (sourceError) console.error(`style_variant_source_unreadable version=${request.sourceVersionId} error=${sourceError.message}`);
    const owningStyle = (source as { assets?: { style_id?: string | null } } | null)?.assets?.style_id ?? null;
    if (owningStyle === request.styleId && source?.style_generation) {
      try {
        variantPacket = StyleGenerationPacketSchema.parse(source.style_generation);
      } catch {
        variantPacket = null;
      }
    }
  }

  // Library references: another style of the same library may lend its images.
  // They are appended after the style's own references, never interleaved with
  // them, and an edit (whose references belong to its source image) never takes
  // any: the image would no longer match the definition it came from.
  const requestedLibraryIds = request.libraryReferenceIds ?? [];
  if (new Set(requestedLibraryIds).size !== requestedLibraryIds.length) {
    throw new StyleError("INVALID_REQUEST", "Duplicate library reference selection");
  }
  if (requestedLibraryIds.length > 0 && request.operation === "inpaint") {
    throw new StyleError("INVALID_REQUEST", "An edit reuses the references of the image it came from");
  }
  const libraryReferences = new Map<string, OrderedReference>();
  if (requestedLibraryIds.length > 0) {
    if (!style.library_id) throw new StyleError("REFERENCE_NOT_FOUND", "This style is not in a library, so it cannot borrow references");
    const { data: libraryRows, error: libraryError } = await client
      .from("style_references")
      .select("id, content_hash, styles!inner(id, library_id)")
      .in("id", requestedLibraryIds)
      .eq("styles.library_id", style.library_id)
      .is("retired_at", null);
    if (libraryError) throw new StyleError("REFERENCE_NOT_FOUND", "Unable to verify library references");
    const found = new Map(
      (libraryRows ?? []).map((row) => [row.id as string, { id: row.id as string, content_hash: (row.content_hash ?? null) as string | null }] as const),
    );
    for (const id of requestedLibraryIds) {
      const reference = found.get(id);
      if (!reference) throw new StyleError("REFERENCE_NOT_FOUND", "A library reference is missing, retired, or belongs to another library");
      libraryReferences.set(id, reference);
    }
  }

  let schema: unknown;
  let styleRevision: string;
  let orderedReferences: OrderedReference[];
  if (sourceIsAuthority) {
    // The edit belongs to the image it came from, so the source definition wins
    // even if the style has been revised since.
    schema = sourcePacket!.schema_snapshot;
    styleRevision = sourcePacket!.style_revision;
    orderedReferences = sourcePacket!.reference_snapshot.map((reference) => ({ id: reference.id, content_hash: reference.content_hash }));
  } else {
    const definition = parseDefinition(style);
    if (!definition) {
      throw new StyleError(
        "STYLE_SOURCE_SNAPSHOT_REQUIRED",
        "This image predates a recorded style definition; choose whether to apply the current confirmed style",
      );
    }
    if (request.operation !== "inpaint" && style.status !== "active") {
      throw new StyleError("STYLE_NOT_READY", "Confirm this style's references and analysis before generating images");
    }
    schema = definition.schema_snapshot;
    styleRevision = definition.style_revision;
    orderedReferences = referenceSetFor(definition, request.referenceIds, libraryReferences);
  }

  // A model accepts a bounded number of input images, and a style may hold more
  // references than that. Sending the leading references in definition order
  // keeps the packet legal (the enqueue function accepts an ordered subset) and
  // tells the user exactly what was left out instead of silently dropping it.
  const warnings: string[] = [];
  const totalReferences = orderedReferences.length;
  if (totalReferences > 0) {
    const catalog = await getModelCatalog(service, style.workspace_id);
    const entry = catalog.find((model) => model.id === request.requestedModelId);
    // A non-text operation spends one input slot on the source image itself.
    const capacity = (entry?.maxInputImages ?? 4) - (request.operation === "text_to_image" ? 0 : 1);
    const limit = Math.max(1, capacity);
    if (totalReferences > limit) {
      orderedReferences = orderedReferences.slice(0, limit);
      warnings.push(`Using ${limit} of ${totalReferences} references: this model accepts at most ${limit} input images.`);
    }
  }

  // Rows must still exist for this style with the recorded hash.  Retired rows
  // are valid here: an authorized snapshot is resolving them by id and hash.
  // Library references were verified by their own lookup above.
  const authorityIds = orderedReferences.filter((reference) => !libraryReferences.has(reference.id)).map((reference) => reference.id);
  const available = new Map<string, string>();
  if (authorityIds.length > 0) {
    const { data: referenceRows, error: referenceError } = await client
      .from("style_references")
      .select("id, content_hash")
      .eq("style_id", request.styleId)
      .in("id", authorityIds);
    if (referenceError) throw new StyleError("REFERENCE_NOT_FOUND", "Unable to verify style references");
    for (const row of referenceRows ?? []) available.set(row.id as string, (row.content_hash ?? "") as string);
  }
  for (const reference of orderedReferences) {
    const expected = libraryReferences.get(reference.id)?.content_hash ?? available.get(reference.id);
    if (expected !== (reference.content_hash ?? "")) {
      throw new StyleError("REFERENCE_NOT_FOUND", "A reference image is missing or changed since the style was confirmed");
    }
  }

  const referenceIds = orderedReferences.map((reference) => reference.id);
  const plan = await resolveImageExecutionPlan(client, {
    ...request,
    prompt,
    referenceIds,
    styleId: request.styleId,
    preserveRequestedModel: true,
 }, service);
  const packet = compileStyleGenerationPacket({
    styleId: request.styleId,
    styleRevision,
    schema: schema as never,
    originalPrompt: prompt,
    contentOverrides: (request.contentOverrides ?? null) as StyleContentOverrides | null,
    references: orderedReferences,
    libraryReferenceIds: orderedReferences.filter((reference) => libraryReferences.has(reference.id)).map((reference) => reference.id),
    operation: request.operation,
    sourceVersionId: request.sourceVersionId ?? null,
    sourcePacket: sourceIsAuthority ? sourcePacket : variantPacket,
    editTarget: request.editTarget ?? null,
    model: request.requestedModelId as SupportedModelId,
    size: request.size as SupportedSize,
    quality: request.quality as SupportedQuality,
    count: request.count as 1 | 2 | 3 | 4,
    background: request.background === "transparent" ? "transparent" : null,
    useCurrentStyle: request.useCurrentStyle,
    sourceOriginalPrompt: request.sourceOriginalPrompt ?? null,
  });
  const planHash = hashPlan(packet, request.sourceAssetId ?? null, request.maskId ?? null, request.useCurrentStyle === true);
  if (packet.metadata?.style_provenance === "current_style_fallback") {
    warnings.push("This image predates a recorded style definition; the current confirmed style is applied to the edited area");
  }
  return {
    plan: { ...plan, styleRevision: packet.style_revision, compiledPrompt: packet.compiled_prompt, planHash, warnings },
    packet: StyleGenerationPacketSchema.parse(packet),
  };
}
