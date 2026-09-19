// Analysis inputs shared by both style domains: reference bytes, the quality
// summary computed on the originals, the bounded copies actually sent, and the
// provider call itself.  The two domains differ in their prompts, their schema
// normalisation and their durable definition - never in how references are read.
import type { SupabaseClient } from "@supabase/supabase-js";

import { STORAGE_BUCKET } from "@/db/schema";
import { StyleError } from "./errors";
import { preprocessReferences, type ReferenceInput, type ReferencePreprocessSummary } from "./reference-preprocess";
import { downscaleReferences } from "./analysis-references";
import { stripMarkdownFence } from "./providers/prompts";
import type { StyleAnalysisProvider } from "./providers/types";
import { GoogleStyleProvider } from "./providers/google";
import { OpenAiStyleProvider } from "./providers/openai";
import type { StyleProviderConfig } from "./providers/config";

export const ANALYSIS_TIMEOUT_MS = 150_000;

export interface AnalysisReferenceRow {
  id: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  content_hash: string | null;
}

export interface AnalysisReferenceSet {
  /** What the analysis is of: an ordered id/hash snapshot, for staleness checks. */
  snapshot: Array<{ id: string; content_hash: string }>;
  /** The measured originals. */
  inputs: ReferenceInput[];
  summary: ReferencePreprocessSummary;
  /** Bounded copies that go to the provider. */
  bounded: ReferenceInput[];
}

export function buildAnalysisProvider(config: StyleProviderConfig): StyleAnalysisProvider {
  return config.provider === "google"
    ? new GoogleStyleProvider(config.apiKey, config.model)
    : new OpenAiStyleProvider(config.apiKey, config.model);
}

async function downloadOwnedReferenceBytes(service: SupabaseClient, path: string): Promise<Buffer> {
  const { data, error } = await service.storage.from(STORAGE_BUCKET).download(path);
  if (error || !data) throw new StyleError("STYLE_ANALYSIS_FAILED", `Failed to load reference ${path} from storage`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Read every live reference once: the analysis must prove which set it saw, so a
 * missing hash is refused here instead of producing an unverifiable result.
 */
export async function loadAnalysisReferences(params: {
  service: SupabaseClient;
  references: readonly AnalysisReferenceRow[];
}): Promise<AnalysisReferenceSet> {
  const { service, references } = params;
  const snapshot = references.map((reference) => ({ id: reference.id, content_hash: reference.content_hash ?? "" }));
  // Presence only: the format is enforced where a reference is registered and
  // where a definition is confirmed, and older rows must stay analysable.
  if (snapshot.some((entry) => entry.content_hash.length === 0)) {
    throw new StyleError("INVALID_REQUEST", "A reference image is missing its content hash; remove and upload it again");
  }
  const inputs: ReferenceInput[] = await Promise.all(
    references.map(async (reference) => ({
      id: reference.id,
      mimeType: reference.mime_type,
      buffer: await downloadOwnedReferenceBytes(service, reference.storage_path),
    })),
  );
  const summary = await preprocessReferences(inputs);
  // The report above was measured on the originals, so bounding happens after it.
  const bounded = await downscaleReferences(inputs);
  return { snapshot, inputs, summary, bounded };
}

export async function requestStyleAnalysis(params: {
  config: StyleProviderConfig;
  references: readonly ReferenceInput[];
  summary: ReferencePreprocessSummary;
  systemPrompt: string;
  userMessage: string;
  timeoutMs?: number;
}): Promise<string> {
  const provider = buildAnalysisProvider(params.config);
  const result = await provider.analyze({
    references: params.references.map(({ buffer, mimeType }) => ({ buffer, mimeType })),
    systemPrompt: params.systemPrompt,
    userMessage: params.userMessage,
    referenceSummary: params.summary,
    timeoutMs: params.timeoutMs ?? ANALYSIS_TIMEOUT_MS,
  });
  return result.rawText;
}

/** Provider replies arrive fenced or bare; both are accepted, nothing else is. */
export function parseAnalysisJson(rawText: string, failureCode: string, failureMessage: string): unknown {
  try {
    return JSON.parse(stripMarkdownFence(rawText));
  } catch {
    throw new StyleError(failureCode, failureMessage);
  }
}
