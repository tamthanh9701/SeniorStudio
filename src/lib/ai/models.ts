import { GoogleGenAI, type Model } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getProviderApiKey } from "@/lib/ai/credentials";
import type { AiOperation, AiProvider, SupportedModelId, SupportedQuality, SupportedSize } from "@/db/ai-jobs";
/**
 * Resolve the user's workspace ID from their membership row.
 * Used by server components and API routes before catalog/credential lookups.
 */
export async function resolveUserWorkspaceId(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await client
    .from("workspace_members")
    .select("workspace_id")
    .eq("supabase_user_id", userId)
    .maybeSingle();
  return data?.workspace_id ?? null;
}

export type ModelCatalogEntry = {
  id: SupportedModelId;
  label: string;
  description?: string;
  provider: AiProvider;
  operations: readonly AiOperation[];
  sizes: readonly SupportedSize[];
  qualities: readonly SupportedQuality[];
  maxCount: 1 | 4;
  supportsReferenceImages?: boolean;
  maxInputImages?: number;
  supportsTemperature?: false;
};

const OPENAI_MODEL: ModelCatalogEntry = {
  id: "openai/gpt-image-2", label: "OpenAI GPT Image 2", provider: "openai",
  operations: ["text_to_image", "image_to_image", "inpaint"], sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
  qualities: ["low", "medium", "high", "auto"], maxCount: 4, supportsReferenceImages: true, maxInputImages: 16, supportsTemperature: false,
};

const GOOGLE_IMAGE_MODEL_IDS: Record<string, true> = {
  "gemini-3.1-flash-image": true,
  "gemini-3-pro-image": true,
  "gemini-3.1-flash-lite-image": true,
  "gemini-2.5-flash-image": true,
};

const GOOGLE_CANDIDATE_MODEL_IDS: Record<string, true> = {
  "gemini-3.1-flash-image": true,
  "gemini-3-pro-image": true,
};

function googleCatalogEntry(model: Model): ModelCatalogEntry | null {
  const modelName = model.name?.replace(/^models\//, "");
  if (!modelName || !GOOGLE_IMAGE_MODEL_IDS[modelName]) return null;
  return {
    id: `google/${modelName}`,
    label: model.displayName?.trim() || modelName,
    description: model.description?.trim() || undefined,
    provider: "google",
    operations: GOOGLE_IMAGE_MODEL_IDS[modelName] === GOOGLE_CANDIDATE_MODEL_IDS[modelName]
      ? ["text_to_image", "image_to_image"]
      : ["text_to_image"],
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["auto"],
    maxCount: 4,
    supportsReferenceImages: true,
    maxInputImages: 4,
    supportsTemperature: false,
  };
}

export async function getModelCatalog(catalogClient: SupabaseClient, workspaceId: string): Promise<ModelCatalogEntry[]> {
  const apiKey = await getProviderApiKey("google", { user: catalogClient, workspaceId });
  const catalog = [OPENAI_MODEL];
  if (!apiKey) return catalog;
  try {
    const pager = await new GoogleGenAI({ apiKey }).models.list({ config: { pageSize: 100, queryBase: true } });
    for await (const model of pager) {
      const entry = googleCatalogEntry(model);
      if (entry) catalog.push(entry);
    }
  } catch (error) {
    console.warn("google_model_catalog_unavailable", error instanceof Error ? error.message : error);
  }
  return catalog;
}

export async function getModel(modelId: string, catalogClient: SupabaseClient, workspaceId: string): Promise<ModelCatalogEntry> {
  const model = (await getModelCatalog(catalogClient, workspaceId)).find((entry) => entry.id === modelId);
  if (!model) throw new Error("INVALID_MODEL");
  return model;
}

export async function assertModelSupports(modelId: SupportedModelId, operation: AiOperation, catalogClient: SupabaseClient, workspaceId: string) {
  const model = await getModel(modelId, catalogClient, workspaceId);
  if (!model.operations.includes(operation)) throw new Error("INVALID_MODEL");
  return model;
}

export const INPAINT_MODELS: readonly ModelCatalogEntry[] = [OPENAI_MODEL];
