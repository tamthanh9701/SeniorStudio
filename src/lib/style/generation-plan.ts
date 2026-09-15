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
import type { SupportedModelId, SupportedQuality, SupportedSize } from "@/db/ai-jobs";

export type StyleGenerationPlanRequest = ExecutionPlanRequest & {
  styleId: string;
  prompt: string;
  referenceIds: string[];
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
): OrderedReference[] {
  const snapshot: OrderedReference[] = definition.reference_snapshot.map((reference) => ({ id: reference.id, content_hash: reference.content_hash }));
  if (requested.length === 0) return snapshot;
  const known = new Map(snapshot.map((reference) => [reference.id, reference]));
  if (requested.length !== snapshot.length || !requested.every((id) => known.has(id))) {
    throw new StyleError("STYLE_CONFLICT", "Requested references do not match the confirmed style definition");
  }
  return requested.map((id) => known.get(id)!);
}

function parseDefinition(style: StyleRow): ConfirmedStyleDefinition | null {
  try {
    return parseConfirmedDefinition(style.confirmed_definition);
  } catch {
    throw new StyleError("STYLE_DEFINITION_INVALID", "The stored style definition is malformed; confirm the style again");
  }
}

export async function resolveStyleGenerationPlan(client: SupabaseClient, request: StyleGenerationPlanRequest): Promise<StyleGenerationPlan> {
  const prompt = request.prompt?.trim() ?? "";
  const { data: styleData, error: styleError } = await client
    .from("styles")
    .select("id, status, schema, updated_at, workspace_id, confirmed_definition")
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
    const { data: source } = await client
      .from("asset_versions")
      .select("style_generation, assets!inner(style_id)")
      .eq("id", request.sourceVersionId)
      .maybeSingle();
    const owningStyle = (source as { assets?: { style_id?: string | null } } | null)?.assets?.style_id ?? null;
    if (owningStyle === request.styleId && source?.style_generation) {
      try {
        variantPacket = StyleGenerationPacketSchema.parse(source.style_generation);
      } catch {
        variantPacket = null;
      }
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
    orderedReferences = referenceSetFor(definition, request.referenceIds);
  }

  // Rows must still exist for this style with the recorded hash.  Retired rows
  // are valid here: an authorized snapshot is resolving them by id and hash.
  const referenceIds = orderedReferences.map((reference) => reference.id);
  const { data: referenceRows, error: referenceError } = await client
    .from("style_references")
    .select("id, content_hash")
    .eq("style_id", request.styleId)
    .in("id", referenceIds);
  if (referenceError) throw new StyleError("REFERENCE_NOT_FOUND", "Unable to verify style references");
  const available = new Map((referenceRows ?? []).map((row) => [row.id as string, (row.content_hash ?? "") as string]));
  for (const reference of orderedReferences) {
    if (available.get(reference.id) !== (reference.content_hash ?? "")) {
      throw new StyleError("REFERENCE_NOT_FOUND", "A reference image is missing or changed since the style was confirmed");
    }
  }

  const plan = await resolveImageExecutionPlan(client, {
    ...request,
    prompt,
    referenceIds,
    styleId: request.styleId,
    preserveRequestedModel: true,
  });
  const packet = compileStyleGenerationPacket({
    styleId: request.styleId,
    styleRevision,
    schema: schema as never,
    originalPrompt: prompt,
    contentOverrides: (request.contentOverrides ?? null) as StyleContentOverrides | null,
    references: orderedReferences,
    operation: request.operation,
    sourceVersionId: request.sourceVersionId ?? null,
    sourcePacket: sourceIsAuthority ? sourcePacket : variantPacket,
    editTarget: request.editTarget ?? null,
    model: request.requestedModelId as SupportedModelId,
    size: request.size as SupportedSize,
    quality: request.quality as SupportedQuality,
    count: request.count as 1 | 2 | 3 | 4,
    useCurrentStyle: request.useCurrentStyle,
    sourceOriginalPrompt: request.sourceOriginalPrompt ?? null,
  });
  const planHash = hashPlan(packet, request.sourceAssetId ?? null, request.maskId ?? null, request.useCurrentStyle === true);
  const warnings: string[] = [];
  if (packet.metadata?.style_provenance === "current_style_fallback") {
    warnings.push("This image predates a recorded style definition; the current confirmed style is applied to the edited area");
  }
  return {
    plan: { ...plan, styleRevision: packet.style_revision, compiledPrompt: packet.compiled_prompt, planHash, warnings },
    packet: StyleGenerationPacketSchema.parse(packet),
  };
}
