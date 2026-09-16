// Style profile service: analyze (vision provider → schema/fingerprint/contract).
// Generation compiles prompts from the confirmed definition in
// generation-plan.ts; nothing here builds a provider prompt from the mutable
// candidate schema.
import { getServiceClient, createClient } from "@/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STORAGE_BUCKET } from "@/db/schema";
import { StyleError } from "./errors";
import { normalizePromptSchema } from "./normalize-prompt-schema";
import { lintAndFixStyleSchema } from "./linter";
import { buildStyleInvariantContract, critiqueStyleSchema } from "./invariant-contract";
import { buildStyleGenerationPrompt, type PromptSchema } from "./prompt-schema";
import { preprocessReferences, type ReferenceInput, type ReferencePreprocessSummary } from "./reference-preprocess";
import { downscaleReferences } from "./analysis-references";
import { resolveStyleProviderConfig } from "./providers/config";
import { GoogleStyleProvider } from "./providers/google";
import { OpenAiStyleProvider } from "./providers/openai";
import { ANALYZE_STYLE_SYSTEM, buildAnalysisUserMessage, pickAiPromptSchema, stripMarkdownFence } from "./providers/prompts";
import type { StyleAnalysisProvider } from "./providers/types";
import { STYLE_ANALYSIS_FRAMEWORK_VERSION } from "./analysis-framework";
import { buildStyleClarificationQuestions } from "./clarification-questions";
import { scoreStyleOperability } from "./operability-scorer";
import { commitStyleAnalysis } from "./schema-versions";
import { styleFingerprintToPrompt, type StyleFingerprint } from "./fingerprint";
import { getStyleBudget, type CostMode } from "./cost-modes";

export const STYLE_ENGINE_SOURCE_COMMIT = "dfab2fea903923e4a19171cc4a2eb4cf4144d8ae";
const PROVIDER_TIMEOUT_MS = 150_000;

export interface StyleRow {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  schema: unknown;
  fingerprint: unknown;
  invariant_contract: unknown;
  analysis_meta: Record<string, unknown>;
  clarification_questions?: unknown;
  clarification_answers?: unknown;
  operability?: unknown;
  last_fidelity?: unknown;
  created_at: string;
  updated_at: string;
}

interface StyleReferenceRow {
  id: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  content_hash: string | null;
}

function buildProvider(providerId: "openai" | "google", model: string, apiKey: string): StyleAnalysisProvider {
  return providerId === "google"
    ? new GoogleStyleProvider(apiKey, model)
    : new OpenAiStyleProvider(apiKey, model);
}

async function downloadReferenceBytes(service: SupabaseClient, path: string): Promise<Buffer> {
  const { data, error } = await service.storage.from(STORAGE_BUCKET).download(path);
  if (error || !data) throw new StyleError("STYLE_ANALYSIS_FAILED", `Failed to load reference ${path} from storage`);
  return Buffer.from(await data.arrayBuffer());
}

export async function analyzeStyleProfile(params: {
  styleId: string;
  userContext?: string;
  client: SupabaseClient;
}): Promise<StyleRow> {
  const { styleId, userContext, client } = params;
  const startedAt = Date.now();

  const { data: style, error: styleError } = await client
    .from("styles").select("*").eq("id", styleId).maybeSingle();
  if (styleError || !style) throw new StyleError("STYLE_NOT_FOUND", "Style not found");

  const { data: references, error: refsError } = await client
    .from("style_references").select("id, storage_path, mime_type, byte_size, content_hash").eq("style_id", styleId).is("retired_at", null).order("created_at").order("id");
  if (refsError) throw new StyleError("INVALID_REQUEST", refsError.message);
  if (!references || references.length === 0) throw new StyleError("NO_REFERENCES", "Upload at least one reference image before analyzing");
  // The analysed set is recorded so a later add/retire can be detected as stale
  // and so confirmation can prove which references the definition came from.
  const referenceSnapshot = (references as StyleReferenceRow[]).map((reference) => ({
    id: reference.id,
    content_hash: reference.content_hash,
  }));
  if (referenceSnapshot.some((reference) => !reference.content_hash)) {
    throw new StyleError("INVALID_REQUEST", "A reference image is missing its content hash; remove and upload it again");
  }

  const service = getServiceClient();
  const bytes = await Promise.all(
    (references as StyleReferenceRow[]).map(async (reference) => ({
      reference,
      buffer: await downloadReferenceBytes(service, reference.storage_path),
    })),
  );
  const inputs: ReferenceInput[] = bytes.map(({ reference, buffer }) => ({
    id: reference.id, buffer, mimeType: reference.mime_type,
  }));
  const referenceSummary = await preprocessReferences(inputs);

  const config = await resolveStyleProviderConfig({ user: client, service, workspaceId: style.workspace_id });
  const provider = buildProvider(config.provider, config.model, config.apiKey);
  // The provider receives bounded copies; the report above was measured on the originals.
  const analysisReferences = await downscaleReferences(inputs);
  const result = await provider.analyze({
    references: analysisReferences.map(({ buffer, mimeType }) => ({ buffer, mimeType })),
    systemPrompt: ANALYZE_STYLE_SYSTEM,
    userMessage: buildAnalysisUserMessage({
      styleName: style.name,
      referenceCount: inputs.length,
      userContext,
      referenceSummary,
    }),
    referenceSummary,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });

  let candidate: unknown;
  try {
    candidate = JSON.parse(stripMarkdownFence(result.rawText));
  } catch {
    throw new StyleError("STYLE_ANALYSIS_UNPARSED", "Analysis reply was not valid JSON");
  }
  const normalized = normalizePromptSchema(candidate);
  const schema = pickAiPromptSchema(normalized);
  if (!schema) throw new StyleError("STYLE_ANALYSIS_UNPARSED", "Analysis reply did not contain a recognizable style schema");

  const lintResult = lintAndFixStyleSchema(schema as unknown as PromptSchema, { referenceSummary });
  const fingerprint = lintResult.fingerprint;
  const contract = buildStyleInvariantContract({ schema: lintResult.schema, fingerprint, referenceSummary });
  const quality = critiqueStyleSchema({ schema: lintResult.schema, contract });
  const clarificationQuestions = buildStyleClarificationQuestions({
    schema: lintResult.schema,
    contract,
    schemaQuality: quality,
    referenceSummary,
  });
  const operability = scoreStyleOperability({ promptSchema: lintResult.schema as unknown as Record<string, unknown>, referenceSummary });
  const analyzedAt = new Date().toISOString();

  const analysisMeta = {
    provider: config.provider,
    model: config.model,
    analyzedAt,
    frameworkVersion: STYLE_ANALYSIS_FRAMEWORK_VERSION,
    sourceCommit: STYLE_ENGINE_SOURCE_COMMIT,
    referenceHashes: (references as StyleReferenceRow[]).map((reference) => reference.content_hash).filter(Boolean),
    reference_snapshot: referenceSnapshot,
    referenceCount: inputs.length,
    lintIssueCount: lintResult.issues.length,
    durationMs: Date.now() - startedAt,
    operabilityScore: operability.score,
    operabilityGrade: operability.grade,
  };

  const updated = await commitStyleAnalysis(client, {
    styleId,
    expectedUpdatedAt: style.updated_at,
    referenceSnapshot,
    schema: lintResult.schema as unknown as Record<string, unknown>,
    fingerprint: fingerprint as unknown as Record<string, unknown>,
    invariantContract: contract as unknown as Record<string, unknown>,
    styleFields: {
      analysis_meta: analysisMeta,
      clarification_questions: clarificationQuestions,
      operability,
    },
    metadata: { provider: config.provider, model: config.model, analyzedAt },
  });

  return updated as unknown as StyleRow;
}


export { createClient, getServiceClient };
