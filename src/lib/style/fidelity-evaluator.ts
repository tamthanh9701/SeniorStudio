// Ported from Restyle commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae
// (src/lib/style-evaluator.ts). Deterministic style fidelity evaluator:
// compares a generation's detected output against the style fingerprint and
// effective generation packet, producing 0-1 sub-scores, issues and a
// repair prompt. No AI calls.
//
// `EffectiveGenerationPacket` is inlined below (from restyle's
// image-generation-pipeline.ts) to avoid a transitive dependency on the
// restyle-only generation pipeline; only the fields this evaluator reads are
// guaranteed by callers.
import type { StyleFingerprint } from './fingerprint';

export type StyleEvalSeverity = 'info' | 'warning' | 'major';

export type StyleEvalCostMode =
  | 'strict_style'
  | 'strict_1000'
  | 'balanced'
  | 'quality';

export type StyleEvalLayoutMode = 'sticker_asset' | 'full_canvas' | 'asset_sheet';

export interface EffectiveGenerationPacket {
  provider?: string;
  requestedModel?: string;
  effectiveModel?: string;
  requestedImageSize?: string;
  effectiveImageSize?: string;
  costMode: StyleEvalCostMode;
  cappedByBudget?: boolean;
  estimatedCostVndPerImage?: number;
  referenceCount: number;
  referenceLimit: number;
  referencesUsed: number;
  mediaResolution?: string;
  layoutMode: StyleEvalLayoutMode;
  styleCapsule: string;
  contentBrief: string;
  promptPreview: string;
  styleFingerprint?: StyleFingerprint;
  warnings: string[];
}

export interface StyleEvalIssue {
  category:
    | 'palette'
    | 'background'
    | 'line_texture'
    | 'composition'
    | 'content'
    | 'model_policy';
  severity: StyleEvalSeverity;
  message: string;
  repair_hint: string;
}

export interface StyleFidelityEvaluation {
  style_fidelity: number;
  palette_fidelity: number;
  background_policy_match: number;
  line_texture_fidelity: number;
  composition_match: number;
  content_match: number;
  issues: StyleEvalIssue[];
  failure_reasons: string[];
  repair_prompt: string;
  should_regenerate_with_stricter_style: boolean;
}

export interface EvaluateStyleFidelityInput {
  fingerprint?: StyleFingerprint | null;
  effectivePacket?: EffectiveGenerationPacket | null;
  contentPrompt?: string;
  negativePrompt?: string;
  userPaletteOverrideHex?: string[];
  detectedOutput?: {
    dominantColors?: string[];
    hasTransparentBackground?: boolean | null;
    backgroundDescription?: string;
    largeFlatFillRatio?: number | null;
    hatchingDensity?: 'none' | 'low' | 'medium' | 'medium_high' | 'high' | 'unknown';
    objectCountEstimate?: number | null;
    textQuality?: 'clean' | 'minor_errors' | 'garbled' | 'unknown';
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function roundScore(value: number): number {
  return Math.round(clampScore(value) * 100) / 100;
}

function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toUpperCase() : null;
}

function overlapRatio(a: string[], b: string[]): number {
  const left = new Set(a.map((item) => item.toUpperCase()));
  const right = new Set(b.map((item) => item.toUpperCase()));
  if (!left.size || !right.size) return 1;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

function includesAny(value: string | undefined, needles: string[]): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function issue(
  category: StyleEvalIssue['category'],
  severity: StyleEvalSeverity,
  message: string,
  repair_hint: string,
): StyleEvalIssue {
  return { category, severity, message, repair_hint };
}

function scorePalette(input: EvaluateStyleFidelityInput, issues: StyleEvalIssue[]): number {
  const overrides = (input.userPaletteOverrideHex || [])
    .map(normalizeHex)
    .filter((item): item is string => Boolean(item));
  const expected = overrides.length
    ? overrides
    : input.fingerprint?.palette_system.detected_hex || [];
  const detected = (input.detectedOutput?.dominantColors || [])
    .map(normalizeHex)
    .filter((item): item is string => Boolean(item));

  if (!expected.length || !detected.length) return 0.75;
  const ratio = overlapRatio(expected, detected);
  if (ratio < 0.5) {
    issues.push(issue(
      'palette',
      'major',
      'Output palette appears to drift from the style palette or user HEX override.',
      `Regenerate using only the expected palette family: ${expected.join(', ')}. Suppress unrelated accent colors.`,
    ));
  } else if (ratio < 0.75) {
    issues.push(issue(
      'palette',
      'warning',
      'Output palette partially matches the style but introduces extra colors.',
      'Reduce accent colors and restate the dominant palette as a hard style lock.',
    ));
  }
  return Math.max(0.2, ratio);
}

function scoreBackground(input: EvaluateStyleFidelityInput, issues: StyleEvalIssue[]): number {
  const policy = input.fingerprint?.background_policy.type;
  const layout = input.effectivePacket?.layoutMode;
  if (policy !== 'transparent_or_plain_light' && layout !== 'sticker_asset') return 0.8;

  const hasTransparent = input.detectedOutput?.hasTransparentBackground;
  const desc = input.detectedOutput?.backgroundDescription;
  const badScene = includesAny(desc, ['room', 'cafe', 'table', 'furniture', 'interior', 'landscape', 'poster']);

  if (hasTransparent === true) return 1;
  if (badScene) {
    issues.push(issue(
      'background',
      'major',
      'Sticker/isolated reference style drifted into a full scene or realistic background.',
      'Remove room/cafe/table/furniture background. Use transparent or plain off-white background with breathing room.',
    ));
    return 0.15;
  }
  if (hasTransparent === false) {
    issues.push(issue(
      'background',
      'warning',
      'Output is not transparent even though the style prefers transparent or plain-light sticker assets.',
      'Ask for transparent background if supported, otherwise plain off-white background only.',
    ));
    return 0.65;
  }
  return 0.7;
}

function scoreLineTexture(input: EvaluateStyleFidelityInput, issues: StyleEvalIssue[]): number {
  const expected = input.fingerprint?.line_system.hatching_density;
  const actual = input.detectedOutput?.hatchingDensity;
  const largeFlatFillRatio = input.detectedOutput?.largeFlatFillRatio;
  if (!expected || expected === 'unknown') return 0.75;

  const expectedRank = ['none', 'low', 'medium', 'medium_high', 'high'].indexOf(expected);
  const actualRank = actual && actual !== 'unknown'
    ? ['none', 'low', 'medium', 'medium_high', 'high'].indexOf(actual)
    : -1;

  let score = actualRank >= 0 ? 1 - Math.max(0, expectedRank - actualRank) * 0.25 : 0.7;
  if (typeof largeFlatFillRatio === 'number' && largeFlatFillRatio > 0.35) {
    score -= 0.25;
    issues.push(issue(
      'line_texture',
      'warning',
      'Output likely contains large untextured fill areas, weakening the hatching/engraving-like texture.',
      'Increase fine colored hatching/parallel contour lines on clothing, hair, phone, props, and other large surfaces.',
    ));
  }
  if (score < 0.55) {
    issues.push(issue(
      'line_texture',
      'major',
      'Line texture/hatching density is below the reference style expectation.',
      'Restate hatching as mandatory and reduce flat vector fills.',
    ));
  }
  return clampScore(score);
}

function scoreComposition(input: EvaluateStyleFidelityInput, issues: StyleEvalIssue[]): number {
  const layout = input.effectivePacket?.layoutMode;
  const objectCount = input.detectedOutput?.objectCountEstimate;
  const backgroundDesc = input.detectedOutput?.backgroundDescription;
  let score = layout === 'sticker_asset' ? 0.8 : 0.75;

  if (layout === 'sticker_asset' && includesAny(backgroundDesc, ['room', 'cafe', 'furniture', 'landscape'])) {
    score -= 0.35;
  }
  if (typeof objectCount === 'number' && objectCount > 6) {
    score -= 0.2;
    issues.push(issue(
      'composition',
      'warning',
      'Composition appears cluttered for a compact sticker/asset style.',
      'Limit supporting props to 1-3 simple requested props and remove decorative clutter.',
    ));
  }
  return clampScore(score);
}

function scoreContent(input: EvaluateStyleFidelityInput, issues: StyleEvalIssue[]): number {
  const textQuality = input.detectedOutput?.textQuality;
  if (textQuality === 'garbled') {
    issues.push(issue(
      'content',
      'warning',
      'Text inside the image appears garbled or unreliable.',
      'Use shorter text, generate the image without detailed text first, then edit/inpaint the text area separately.',
    ));
    return 0.6;
  }
  if (textQuality === 'minor_errors') return 0.75;
  return 0.85;
}

function scoreModelPolicy(input: EvaluateStyleFidelityInput, issues: StyleEvalIssue[]) {
  const packet = input.effectivePacket;
  if (!packet) return;
  if (packet.layoutMode === 'sticker_asset' && packet.costMode === 'strict_1000') {
    issues.push(issue(
      'model_policy',
      'warning',
      'Budget mode was used for a style-sensitive sticker asset generation.',
      'Regenerate with strict_style mode to preserve model, references, media resolution, and lower temperature.',
    ));
  }
  if (packet.referenceCount > 1 && packet.referencesUsed <= 1) {
    issues.push(issue(
      'model_policy',
      'warning',
      'Only one reference was used even though multiple references were available.',
      'Use strict_style mode with 3-4 references for better style fidelity.',
    ));
  }
}

function buildRepairPrompt(input: EvaluateStyleFidelityInput, issues: StyleEvalIssue[]): string {
  const hints = Array.from(new Set(issues.map((item) => item.repair_hint)));
  const base = [
    'Regenerate with stricter style fidelity.',
    'Preserve the reusable style fingerprint; do not copy reference-only objects unless requested.',
  ];
  if (input.effectivePacket?.layoutMode === 'sticker_asset' || input.fingerprint?.background_policy.type === 'transparent_or_plain_light') {
    base.push('Use isolated sticker asset composition with transparent or plain off-white background and breathing room.');
  }
  return [...base, ...hints].join('\n');
}

export function evaluateStyleFidelity(input: EvaluateStyleFidelityInput): StyleFidelityEvaluation {
  const issues: StyleEvalIssue[] = [];
  const palette = scorePalette(input, issues);
  const background = scoreBackground(input, issues);
  const lineTexture = scoreLineTexture(input, issues);
  const composition = scoreComposition(input, issues);
  const content = scoreContent(input, issues);
  scoreModelPolicy(input, issues);

  const styleFidelity = roundScore(
    palette * 0.22 +
      background * 0.24 +
      lineTexture * 0.24 +
      composition * 0.18 +
      content * 0.12,
  );

  const failureReasons = issues
    .filter((item) => item.severity !== 'info')
    .map((item) => item.message);

  return {
    style_fidelity: styleFidelity,
    palette_fidelity: roundScore(palette),
    background_policy_match: roundScore(background),
    line_texture_fidelity: roundScore(lineTexture),
    composition_match: roundScore(composition),
    content_match: roundScore(content),
    issues,
    failure_reasons: failureReasons,
    repair_prompt: buildRepairPrompt(input, issues),
    should_regenerate_with_stricter_style:
      styleFidelity < 0.72 || issues.some((item) => item.severity === 'major'),
  };
}
