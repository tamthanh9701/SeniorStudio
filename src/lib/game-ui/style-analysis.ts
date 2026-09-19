// Game UI style analysis: reference images become a reviewed description of the
// interface language - palette, typography, component chrome - which is what every
// screen is then generated from.  It deliberately skips the visual-domain linter
// and operability scorer: those reason about a scene subject and would report
// nonsense for a button.
import type { SupabaseClient } from "@supabase/supabase-js";

import { GameUiError } from "./errors";
import { parseGameUiStyleSchema, gameUiStyleGrade, gameUiStyleWarnings, type GameUiStyleSchema } from "./style-schema";
import { kindCatalogForPrompt } from "./taxonomy";
import { getServiceClient } from "@/supabase/server";
import { StyleError } from "@/lib/style/errors";
import { commitStyleAnalysis } from "@/lib/style/schema-versions";
import { resolveStyleProviderConfig } from "@/lib/style/providers/config";
import {
  loadAnalysisReferences,
  parseAnalysisJson,
  requestStyleAnalysis,
  type AnalysisReferenceRow,
} from "@/lib/style/analysis-runner";
import type { ReferencePreprocessSummary } from "@/lib/style/reference-preprocess";

export const GAME_UI_ANALYSIS_FRAMEWORK_VERSION = "game_ui_style_v1";

export const ANALYZE_GAME_UI_SYSTEM = `You are an expert game interface art director. You analyse the supplied interface reference images and describe the reusable UI style they share, so another screen can be generated that looks like it belongs to the same game.

Respond with ONLY a JSON object in exactly this shape, no prose and no markdown fence:
{
  "schema_version": 1,
  "domain": "game_ui",
  "name": "short style name",
  "visual_language": "one paragraph describing the shared look",
  "palette": [{ "id": "slug", "role": "background|surface|primary|secondary|accent|text|muted|success|warning|danger|custom", "color": "#RRGGBB", "notes": "where it is used" }],
  "typography": [{ "role": "title|heading|body|caption|numeric|button", "family_description": "letterform character", "weight": "bold", "casing": "unchanged|uppercase|lowercase|title", "effects": "outline, glow, ..." }],
  "layout": { "density": "compact|balanced|spacious", "spacing_rules": "", "alignment_rules": "", "safe_area_rules": "", "hierarchy_rules": "" },
  "shape": { "corner_rules": "", "border_rules": "", "silhouette_rules": "" },
  "surface": { "materials": "", "shading": "", "shadows": "", "highlights": "" },
  "iconography": { "construction": "", "stroke_rules": "", "detail_level": "" },
  "components": [{ "kind": "<element kind>", "appearance": "", "text_rules": "", "composition_rules": "" }],
  "invariants": ["rules that must hold on every screen"],
  "avoid": ["what would break the look"],
  "uncertainties": [{ "field": "field you could not determine", "question": "what to ask the user" }]
}

Element kinds you may use (use these exact identifiers):
${kindCatalogForPrompt()}

Rules:
- Describe the interface language only. Do not copy a specific screen's wording, character names, numbers or logos into the style.
- Palette colours must be #RRGGBB or #RRGGBBAA sampled from the references. Every token needs a distinct lowercase slug id.
- One component entry per kind the references actually show, at most 32.
- State what you can see. When the references do not show something (a corner radius, a font weight, a pressed state), record it in "uncertainties" instead of inventing it.
- At least one invariant is required; it must be checkable by looking at a rendered screen.
- Never output null for a required string: use "" when nothing can be said.`;

/**
 * The user turn for analysis.  The quality summary is included because a
 * low-resolution or pixel-art reference set changes how the style should be read,
 * and the model cannot measure that itself.
 */
export function buildGameUiAnalysisUserMessage(params: {
  styleName: string;
  referenceCount: number;
  userContext?: string;
  summary: ReferencePreprocessSummary;
}): string {
  const lines = [
    `Style name: ${params.styleName}`,
    `Reference images: ${params.referenceCount}`,
    `Detected reference format: ${params.summary.dominantAssetFormat}`,
    `Detected dominant colours: ${params.summary.dominantColors.slice(0, 12).join(", ") || "none measured"}`,
    `Low-resolution references: ${params.summary.qualityReport.lowResolutionCount}`,
    `Pixel-art ambiguity: ${params.summary.qualityReport.pixelArtAmbiguity}`,
  ];
  if (params.userContext?.trim()) lines.push(`User context: ${params.userContext.trim()}`);
  lines.push("Describe this UI style as the JSON object defined in the system message.");
  return lines.join("\n");
}

function styleWarnings(style: GameUiStyleSchema): string[] {
  return gameUiStyleWarnings(style);
}

/**
 * Analyze the live references of a Game UI style and commit the candidate.
 * The confirmed definition is not touched: confirmation is a separate, explicit step.
 */
export async function analyzeGameUiStyle(params: {
  styleId: string;
  userContext?: string;
  client: SupabaseClient;
}) {
  const { styleId, userContext, client } = params;
  const startedAt = Date.now();
  const { data: style, error: styleError } = await client
    .from("styles")
    .select("id, workspace_id, name, domain, status, updated_at, analysis_meta")
    .eq("id", styleId)
    .maybeSingle();
  if (styleError || !style) throw new StyleError("STYLE_NOT_FOUND", "Style not found");
  if (style.domain !== "game_ui") throw new GameUiError("INVALID_REQUEST", "This is a visual style; use the Style module");

  const { data: references, error: refsError } = await client
    .from("style_references")
    .select("id, storage_path, mime_type, byte_size, content_hash")
    .eq("style_id", styleId)
    .is("retired_at", null)
    .order("created_at")
    .order("id");
  if (refsError) throw new StyleError("INVALID_REQUEST", refsError.message);
  if (!references || references.length === 0) {
    throw new StyleError("NO_REFERENCES", "Upload at least one reference image before analyzing");
  }

  const service = getServiceClient();
  const referenceSet = await loadAnalysisReferences({ service, references: references as AnalysisReferenceRow[] });
  const config = await resolveStyleProviderConfig({ service, workspaceId: style.workspace_id as string });
  const rawText = await requestStyleAnalysis({
    config,
    references: referenceSet.bounded,
    summary: referenceSet.summary,
    systemPrompt: ANALYZE_GAME_UI_SYSTEM,
    userMessage: buildGameUiAnalysisUserMessage({
      styleName: style.name as string,
      referenceCount: referenceSet.inputs.length,
      userContext,
      summary: referenceSet.summary,
    }),
  });

  const candidate = parseAnalysisJson(rawText, "GAME_UI_ANALYSIS_INVALID", "Analysis reply was not valid JSON");
  let schema: GameUiStyleSchema;
  try {
    schema = parseGameUiStyleSchema(candidate);
  } catch (error) {
    throw new GameUiError(
      "GAME_UI_ANALYSIS_INVALID",
      `Analysis reply did not match the Game UI schema: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  const analyzedAt = new Date().toISOString();
  const warnings = styleWarnings(schema);
  const grade = gameUiStyleGrade(schema);
  const updated = await commitStyleAnalysis(client, {
    styleId,
    expectedUpdatedAt: style.updated_at as string,
    referenceSnapshot: referenceSet.snapshot,
    // The two fields the rest of the pipeline reads as "domain identity": a
    // fingerprint of what the style looks like, and the rules a screen must keep.
    schema: schema as unknown as Record<string, unknown>,
    fingerprint: {
      domain: "game_ui",
      schema_version: 1,
      palette: schema.palette.map((token) => ({ role: token.role, color: token.color })),
      shape: schema.shape,
      iconography: schema.iconography,
    },
    invariantContract: {
      domain: "game_ui",
      schema_version: 1,
      invariants: schema.invariants,
      avoid: schema.avoid,
    },
    styleFields: {
      analysis_meta: {
        provider: config.provider,
        model: config.model,
        analyzedAt,
        frameworkVersion: GAME_UI_ANALYSIS_FRAMEWORK_VERSION,
        reference_snapshot: referenceSet.snapshot,
        referenceCount: referenceSet.inputs.length,
        warnings,
      },
      operability: { grade, warnings },
    },
    metadata: { provider: config.provider, model: config.model, analyzedAt, durationMs: Date.now() - startedAt },
  });
  return updated;
}
