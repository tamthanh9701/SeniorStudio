// ============================================================
// Deterministic style operability scorer.
//
// The real implementation behind skill `test_style_operability`.
// No AI calls: readiness is judged from the PromptSchema structure and
// the reference preprocessing quality report, so creators get an
// instant, free signal before spending money on generation runs.
// ============================================================

type CheckStatus = 'pass' | 'warn' | 'fail';

export interface OperabilityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface OperabilityResult {
  score: number;
  grade: 'production_ready' | 'usable_with_warnings' | 'not_ready';
  checks: OperabilityCheck[];
}

interface ReferenceSummaryInput {
  hasAnyAlpha?: boolean;
  dominantAssetFormat?: string;
  qualityReport?: {
    hasLowResolutionReferences?: boolean;
    pixelArtAmbiguity?: string;
  } | null;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0;
}

function fieldText(schema: Record<string, unknown>, section: string, key: string): string {
  const sec = schema[section];
  if (typeof sec !== 'object' || sec === null) return '';
  const val = (sec as Record<string, unknown>)[key];
  return typeof val === 'string' ? val.trim() : '';
}

/**
 * Identity, palette and rendering are hard requirements (fail => heavy);
 * negative rules / composition / reference quality degrade to warnings.
 */
export function scoreStyleOperability(input: {
  promptSchema?: Record<string, unknown> | null;
  referenceSummary?: ReferenceSummaryInput | null;
}): OperabilityResult {
  const schema = input.promptSchema ?? {};
  const refs = input.referenceSummary ?? null;
  const checks: OperabilityCheck[] = [];

  const hasName = typeof schema.style_name === 'string' && schema.style_name.trim().length > 0;
  checks.push({
    id: 'identity',
    label: 'Schema identity (style_name)',
    status: hasName ? 'pass' : 'fail',
    detail: hasName ? String(schema.style_name) : 'Missing style_name — generations cannot be audited',
  });

  const subjectType = typeof schema.subject_type === 'string' ? schema.subject_type.trim() : '';
  checks.push({
    id: 'subject',
    label: 'Subject type declared',
    status: subjectType ? 'pass' : 'warn',
    detail: subjectType || 'subject_type empty; content/style separation is weaker',
  });

  const palette = schema.color_palette as Record<string, unknown> | undefined;
  const colors = nonEmptyStringArray(palette?.dominant_colors) ? palette?.dominant_colors : [];
  checks.push({
    id: 'palette',
    label: 'Dominant colors extracted',
    status: colors.length >= 3 ? 'pass' : colors.length > 0 ? 'warn' : 'fail',
    detail: `${colors.length} color(s)`,
  });

  const rendering = fieldText(schema, 'artistic_style', 'rendering_style') ||
    fieldText(schema, 'artistic_style', 'medium');
  checks.push({
    id: 'rendering',
    label: 'Rendering/material rules present',
    status: rendering ? 'pass' : 'fail',
    detail: rendering ? rendering.slice(0, 80) : 'No rendering_style/medium — model will improvise surfaces',
  });

  const negatives = schema.negative_prompt as Record<string, unknown> | undefined;
  const negativeCount = negatives
    ? Object.values(negatives).filter((v) => nonEmptyStringArray(v)).length
    : 0;
  checks.push({
    id: 'negative',
    label: 'Negative drift rules',
    status: negativeCount >= 1 ? 'pass' : 'warn',
    detail: `${negativeCount} rule group(s); empty means unbounded style drift`,
  });

  const composition = fieldText(schema, 'composition', 'framing') ||
    fieldText(schema, 'environment', 'background_elements') ||
    fieldText(schema, 'composition', 'negative_space');
  checks.push({
    id: 'composition',
    label: 'Composition/background policy',
    status: composition ? 'pass' : 'warn',
    detail: composition ? composition.slice(0, 80) : 'No background policy; transparent references may become full scenes',
  });

  const lowRes = refs?.qualityReport?.hasLowResolutionReferences === true;
  checks.push({
    id: 'refs_quality',
    label: 'Reference resolution quality',
    status: lowRes ? 'warn' : 'pass',
    detail: lowRes
      ? `Low-resolution references detected${refs?.qualityReport?.pixelArtAmbiguity && refs.qualityReport.pixelArtAmbiguity !== 'unknown' ? ` (${refs.qualityReport.pixelArtAmbiguity})` : ''}`
      : 'References pass resolution screening',
  });

  const weights: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0 };
  const score = Math.round(
    (checks.reduce((sum, c) => sum + weights[c.status], 0) / checks.length) * 100,
  );

  // production_ready demands a fully clean sheet — any warning demotes the
  // grade so creators always see what to fix before paid generation runs.
  const failedHard = checks.some((c) => c.status === 'fail');
  const allPassed = checks.every((c) => c.status === 'pass');
  const grade: OperabilityResult['grade'] =
    !failedHard && allPassed && score >= 85
      ? 'production_ready'
      : !failedHard && score >= 60
        ? 'usable_with_warnings'
        : 'not_ready';

  return { score, grade, checks };
}
