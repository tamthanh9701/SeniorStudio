// Style profile service: analyze (vision provider → schema/fingerprint/contract).
// Generation compiles prompts from the confirmed definition in
// generation-plan.ts; nothing here builds a provider prompt from the mutable
// candidate schema.
import { getServiceClient, createClient } from "@/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StyleError } from "./errors";
import { normalizePromptSchema } from "./normalize-prompt-schema";
import { lintAndFixStyleSchema } from "./linter";
import { buildStyleInvariantContract, critiqueStyleSchema } from "./invariant-contract";
import { buildStyleGenerationPrompt, type PromptSchema } from "./prompt-schema";
import { resolveStyleProviderConfig } from "./providers/config";
import { ANALYZE_STYLE_SYSTEM, buildAnalysisUserMessage, pickAiPromptSchema } from "./providers/prompts";
import {
  ANALYSIS_TIMEOUT_MS,
  loadAnalysisReferences,
  parseAnalysisJson,
  requestStyleAnalysis,
  type AnalysisReferenceRow,
} from "./analysis-runner";
import { analyzeGameUiStyle } from "@/lib/game-ui/style-analysis";
import { STYLE_ANALYSIS_FRAMEWORK_VERSION } from "./analysis-framework";
import { buildStyleClarificationQuestions } from "./clarification-questions";
import { scoreStyleOperability } from "./operability-scorer";
import { commitStyleAnalysis } from "./schema-versions";
import { styleFingerprintToPrompt, type StyleFingerprint } from "./fingerprint";
import { getStyleBudget, type CostMode } from "./cost-modes";

export const STYLE_ENGINE_SOURCE_COMMIT = "dfab2fea903923e4a19171cc4a2eb4cf4144d8ae";

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
  // The stored domain decides how a reference set is read; a caller cannot pick it.
  if ((style as { domain?: string }).domain === "game_ui") {
    return (await analyzeGameUiStyle({ styleId, userContext, client })) as unknown as StyleRow;
  }

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
  const referenceSet = await loadAnalysisReferences({
    service,
    references: references as AnalysisReferenceRow[],
  });
  const { inputs, summary: referenceSummary, bounded } = referenceSet;

  const config = await resolveStyleProviderConfig({ service, workspaceId: style.workspace_id });
  const rawText = await requestStyleAnalysis({
    config,
    references: bounded,
    summary: referenceSummary,
    systemPrompt: ANALYZE_STYLE_SYSTEM,
    userMessage: buildAnalysisUserMessage({
      styleName: style.name,
      referenceCount: inputs.length,
      userContext,
      referenceSummary,
    }),
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
  const candidate = parseAnalysisJson(rawText, "STYLE_ANALYSIS_UNPARSED", "Analysis reply was not valid JSON");
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
