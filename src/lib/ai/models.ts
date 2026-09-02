import { GoogleGenAI, type Model } from "@google/genai";
import { getProviderApiKey } from "@/lib/ai/credentials";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiOperation, AiProvider, SupportedModelId, SupportedQuality, SupportedSize } from "@/db/ai-jobs";

export type ModelCatalogEntry = {
  id: SupportedModelId;
  label: string;
  description?: string;
  provider: AiProvider;
  operations: readonly AiOperation[];
  sizes: readonly SupportedSize[];
  qualities: readonly SupportedQuality[];
  maxCount: 1 | 4;
};

const OPENAI_MODEL: ModelCatalogEntry = {
  id: "openai/gpt-image-2", label: "OpenAI GPT Image 2", provider: "openai",
  operations: ["text_to_image", "inpaint"], sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
  qualities: ["low", "medium", "high", "auto"], maxCount: 4,
};

const GOOGLE_IMAGE_MODEL_IDS: Record<string, true> = {
  "gemini-3.1-flash-image": true,
  "gemini-3.1-flash-lite-image": true,
  "gemini-3-pro-image": true,
  "gemini-2.5-flash-image": true,
};

function googleCatalogEntry(model: Model): ModelCatalogEntry | null {
  const modelName = model.name?.replace(/^models\//, "");
  if (!modelName || !GOOGLE_IMAGE_MODEL_IDS[modelName]) return null;
  return {
    id: `google/${modelName}`,
    label: model.displayName?.trim() || modelName,
    description: model.description?.trim() || undefined,
    provider: "google",
    operations: ["text_to_image"],
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["auto"],
    maxCount: 4,
  };
}

export async function getModelCatalog(catalogClient?: SupabaseClient): Promise<ModelCatalogEntry[]> {
  const apiKey = await getProviderApiKey("google", { user: catalogClient });
  const catalog = [OPENAI_MODEL];
  if (!apiKey) return catalog;
  const pager = await new GoogleGenAI({ apiKey }).models.list({ config: { pageSize: 100, queryBase: true } });
  for await (const model of pager) {
    const entry = googleCatalogEntry(model);
    if (entry) catalog.push(entry);
  }
  return catalog;
}

export async function getModel(modelId: string): Promise<ModelCatalogEntry> {
  const model = (await getModelCatalog()).find((entry) => entry.id === modelId);
  if (!model) throw new Error("INVALID_MODEL");
  return model;
}

export async function assertModelSupports(modelId: SupportedModelId, operation: AiOperation) {
  const model = await getModel(modelId);
  if (!model.operations.includes(operation)) throw new Error("INVALID_MODEL");
  return model;
}

export const INPAINT_MODELS: readonly ModelCatalogEntry[] = [OPENAI_MODEL];
