import type { SupabaseClient } from "@supabase/supabase-js";
import { COST_MODE_OPTIONS, getReferenceLimit, type CostMode } from "@/lib/style/cost-modes";
import { getModelCatalog, resolveUserWorkspaceId, type ModelCatalogEntry } from "@/lib/ai/models";
import { getProviderApiKey } from "@/lib/ai/credentials";
import { providerForModel, type SupportedModelId, type AiOperation, type SupportedQuality, type SupportedSize } from "@/db/ai-jobs";

export type ExecutionPlanRequest = {
  operation: AiOperation;
  requestedModelId: string;
  styleId?: string;
  sourceVersionId?: string;
  parentVersionId?: string;
  maskId?: string;
  prompt?: string;
  contentOverrides?: Record<string, unknown> | null;
  editTarget?: string;
  useCurrentStyle?: boolean;
  costMode: CostMode;
  count: number;
  size: string;
  quality: string;
  referenceIds?: string[];
  preserveRequestedModel?: boolean;
};

export const AI_ECONOMY_IMAGE_MODELS: readonly SupportedModelId[] = [
  "google/gemini-3.1-flash-image",
  "google/gemini-3-pro-image",
];

export type ExecutionPlan = {
  operation: AiOperation;
  requestedModelId: SupportedModelId;
  effectiveModelId: SupportedModelId;
  provider: "openai" | "google";
  size: string;
  quality: string;
  count: number;
  styleBudget: number;
  referenceIds: string[];
  sourceVersionId: string | null;
  temperature: null;
  modelChanged: boolean;
  explanation: string;
  supported: boolean;
  styleRevision?: string | null;
  compiledPrompt?: string | null;
  planHash?: string | null;
  warnings?: string[];
};

export type ModelEntry = ModelCatalogEntry & {
  supportsReferenceImages?: boolean;
  maxInputImages?: number;
  supportsTemperature?: false;
};

function compatible(model: ModelEntry, request: ExecutionPlanRequest, referenceCount: number): boolean {
  if (!model.operations.includes(request.operation)) return false;
  if (!model.sizes.includes(request.size as SupportedSize)) return false;
  if (!model.qualities.includes(request.quality as SupportedQuality)) return false;
  if (request.count > model.maxCount) return false;
  if (referenceCount > 0 && !model.supportsReferenceImages) return false;
  const inputCount = referenceCount + (request.operation === "image_to_image" || request.operation === "inpaint" ? 1 : 0);
  return inputCount <= (model.maxInputImages ?? 4);
}

export async function resolveImageExecutionPlan(
  client: SupabaseClient,
  request: ExecutionPlanRequest,
): Promise<ExecutionPlan> {
  const requested = request.requestedModelId as SupportedModelId;
  if (!/^(openai\/gpt-image-2|google\/[a-z0-9._-]+)$/.test(request.requestedModelId)) throw new Error("INVALID_MODEL");
  if (request.operation === "image_to_image" && !request.sourceVersionId) throw new Error("SOURCE_REQUIRED");

  const { data: auth } = await client.auth.getUser();
  if (!auth.user) throw new Error("UNAUTHORIZED");
  const workspaceId = await resolveUserWorkspaceId(client, auth.user.id);
  if (!workspaceId) throw new Error("NOT_FOUND");
  const provider = providerForModel(requested);
  if (!(await getProviderApiKey(provider, { user: client, workspaceId }))) throw new Error("PROVIDER_NOT_CONFIGURED");

  const catalog = (await getModelCatalog(client, workspaceId)) as ModelEntry[];
  const requestedEntry = catalog.find((entry) => entry.id === requested);
  if (!requestedEntry) throw new Error("INVALID_MODEL");
  if (!requestedEntry.operations.includes(request.operation)) throw new Error("INVALID_MODEL");

  const referenceLimit = Math.max(0, (requestedEntry.maxInputImages ?? 4) - (request.operation === "text_to_image" ? 0 : 1));
  const requestedReferenceIds = request.referenceIds ?? [];
  if (new Set(requestedReferenceIds).size !== requestedReferenceIds.length) throw new Error("INVALID_REQUEST");
  let referenceIds: string[] = [];
  if (request.styleId) {
    const { data: refs, error } = await client
      .from("style_references")
      .select("id")
      .eq("style_id", request.styleId);
    if (error) throw new Error(`REFERENCE_LOOKUP_FAILED: ${error.message}`);
    const available = new Set((refs ?? []).map((ref) => ref.id as string));
    if (requestedReferenceIds.some((id) => !available.has(id))) throw new Error("REFERENCE_NOT_FOUND");
    if (requestedReferenceIds.length > referenceLimit) throw new Error(`REFERENCE_LIMIT_EXCEEDED: maximum ${referenceLimit} references for this model`);
    referenceIds = [...requestedReferenceIds];
  } else if (requestedReferenceIds.length > 0) {
    throw new Error("REFERENCE_NOT_FOUND");
  }

  const mode = COST_MODE_OPTIONS.find((entry) => entry.id === request.costMode);
  const settingsCompatible = compatible(requestedEntry, request, referenceIds.length);
  let effective = requestedEntry;
  let explanation = "Requested model supports the requested operation and settings.";

  if (request.preserveRequestedModel || mode?.preserveRequestedModel) {
    if (!settingsCompatible) throw new Error("UNSUPPORTED_SETTINGS");
  } else if (!settingsCompatible) {
    throw new Error("UNSUPPORTED_SETTINGS");
  } else {
    const economyCandidate = AI_ECONOMY_IMAGE_MODELS.find((economyId) => {
      if (economyId === requested) return false;
      const entry = catalog.find((candidate) => candidate.id === economyId);
      return Boolean(entry && entry.provider === provider && compatible(entry, request, referenceIds.length));
    });
    if (economyCandidate) {
      const economyEntry = catalog.find((entry) => entry.id === economyCandidate);
      if (economyEntry) {
        effective = economyEntry;
        explanation = `Cost mode ${request.costMode} selected ${effective.id} to reduce cost.`;
      }
    }
  }

  return {
    operation: request.operation,
    requestedModelId: requested,
    effectiveModelId: effective.id,
    provider: effective.provider,
    size: request.size,
    quality: request.quality,
    count: request.count,
    styleBudget: mode?.styleBudget ?? 1600,
    referenceIds,
    sourceVersionId: request.sourceVersionId ?? null,
    temperature: null,
    modelChanged: effective.id !== requested,
    explanation,
    supported: true,
  };
}
