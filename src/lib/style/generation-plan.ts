import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PromptSchema } from "./prompt-schema";
import {
  compileStyleGenerationPacket,
  StyleGenerationPacketSchema,
  type StyleGenerationPacket,
  type StyleContentOverrides,
} from "./generation-packet";
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

export async function resolveStyleGenerationPlan(client: SupabaseClient, request: StyleGenerationPlanRequest): Promise<StyleGenerationPlan> {
  const prompt = request.prompt?.trim() ?? "";
  const { data: style, error: styleError } = await client.from("styles").select("id, status, schema, updated_at, workspace_id").eq("id", request.styleId).single();
  if (styleError || !style) throw new Error("STYLE_NOT_FOUND");
  if (style.status !== "active") throw new Error("STYLE_NOT_ACTIVE");

  const duplicateIds = new Set(request.referenceIds);
  if (duplicateIds.size !== request.referenceIds.length) throw new Error("INVALID_REQUEST");
  const references = request.referenceIds.length > 0
    ? (await client.from("style_references").select("id, content_hash").eq("style_id", request.styleId).in("id", request.referenceIds)).data ?? []
    : [];
  if (references.length !== request.referenceIds.length) throw new Error("REFERENCE_NOT_FOUND");
  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  const orderedReferences = request.referenceIds.map((id) => {
    const reference = referenceById.get(id);
    if (!reference) throw new Error("REFERENCE_NOT_FOUND");
    return { id, content_hash: reference.content_hash ?? null };
  });

  const plan = await resolveImageExecutionPlan(client, { ...request, prompt, referenceIds: request.referenceIds, preserveRequestedModel: true });
  const sourceVersionId = request.sourceVersionId ?? null;
  const packet = compileStyleGenerationPacket({
    styleId: request.styleId,
    styleRevision: style.updated_at,
    schema: style.schema as PromptSchema,
    originalPrompt: prompt,
    contentOverrides: (request.contentOverrides ?? null) as StyleContentOverrides | null,
    references: orderedReferences,
    operation: request.operation,
    sourceVersionId,
    sourcePacket: request.sourcePacket ?? null,
    editTarget: request.editTarget ?? null,
    model: request.requestedModelId as SupportedModelId,
    size: request.size as SupportedSize,
    quality: request.quality as SupportedQuality,
    count: request.count as 1 | 2 | 3 | 4,
    useCurrentStyle: request.useCurrentStyle,
    sourceOriginalPrompt: request.sourceOriginalPrompt ?? null,
  });
  const compiledPrompt = packet.compiled_prompt;
  const planHash = hashPlan(packet, request.sourceAssetId ?? null, request.maskId ?? null, request.useCurrentStyle === true);
  const warnings: string[] = [];
  if (packet.metadata?.style_provenance === "current_style_fallback") {
    warnings.push("Inpaint source packet not found; using current style schema as fallback for this edit");
  }
  return {
    plan: { ...plan, styleRevision: packet.style_revision, compiledPrompt, planHash, warnings },
    packet: StyleGenerationPacketSchema.parse(packet),
  };
}
