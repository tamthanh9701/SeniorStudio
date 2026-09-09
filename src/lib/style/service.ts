// Style profile service: analyze (vision provider → schema/fingerprint/contract)
// and compileStyledPrompt (capsule + subject) used at generation enqueue time.
import { getServiceClient, createClient } from "@/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STORAGE_BUCKET } from "@/db/schema";
import { StyleError } from "./errors";
import { normalizePromptSchema } from "./normalize-prompt-schema";
import { lintAndFixStyleSchema } from "./linter";
import { buildStyleInvariantContract, critiqueStyleSchema } from "./invariant-contract";
import { buildStyleGenerationPrompt, type PromptSchema } from "./prompt-schema";
import { preprocessReferences, type ReferenceInput, type ReferencePreprocessSummary } from "./reference-preprocess";
import { resolveStyleProviderConfig } from "./providers/config";
import { GoogleStyleProvider } from "./providers/google";
import { OpenAiStyleProvider } from "./providers/openai";
import { ANALYZE_STYLE_SYSTEM, buildAnalysisUserMessage, pickAiPromptSchema, stripMarkdownFence } from "./providers/prompts";
import type { StyleAnalysisProvider } from "./providers/types";
import { STYLE_ANALYSIS_FRAMEWORK_VERSION } from "./analysis-framework";
import { buildStyleClarificationQuestions } from "./clarification-questions";
import { scoreStyleOperability } from "./operability-scorer";
import { commitStyleSchemaMutation } from "./schema-versions";
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
    .from("style_references").select("id, storage_path, mime_type, byte_size, content_hash").eq("style_id", styleId).order("created_at");
  if (refsError) throw new StyleError("INVALID_REQUEST", refsError.message);
  if (!references || references.length === 0) throw new StyleError("NO_REFERENCES", "Upload at least one reference image before analyzing");

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
  const result = await provider.analyze({
    references: inputs.map(({ buffer, mimeType }) => ({ buffer, mimeType })),
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
    referenceCount: inputs.length,
    lintIssueCount: lintResult.issues.length,
    durationMs: Date.now() - startedAt,
    operabilityScore: operability.score,
    operabilityGrade: operability.grade,
  };

  const updated = await commitStyleSchemaMutation(client, {
    styleId,
    expectedUpdatedAt: style.updated_at,
    source: "analysis",
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

export async function compileStyledPrompt(params: {
  styleId: string;
  originalPrompt: string;
  client: SupabaseClient;
  costMode?: CostMode;
  referenceSummary?: ReferencePreprocessSummary | null;
}): Promise<string> {
  const { styleId, originalPrompt, client, costMode = "strict_1000" } = params;
  const { data: style, error } = await client.from("styles").select("status, schema, fingerprint").eq("id", styleId).maybeSingle();
  if (error || !style) throw new StyleError("STYLE_NOT_FOUND", "Style not found");
  if (style.status !== "active") throw new StyleError("STYLE_NOT_ACTIVE", "Style must be activated before use in generation");

  const budget = getStyleBudget(costMode);
  const styleSource = style.fingerprint
    ? styleFingerprintToPrompt(style.fingerprint as StyleFingerprint)
    : buildStyleGenerationPrompt(style.schema as PromptSchema, budget);
  const capsule = styleSource.length > budget ? styleSource.slice(0, budget).trimEnd() : styleSource;
  const overhead = capsule.length + "\n\nSubject: ".length;
  const subject = overhead + originalPrompt.length > 8000
    ? originalPrompt.slice(0, Math.max(0, 8000 - overhead))
    : originalPrompt;
  return `${capsule}\n\nSubject: ${subject}`;
}

export { createClient, getServiceClient };
