// Ported from Restyle commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae
// (src/lib/style-schema-linter.ts). Import paths adjusted only.
import type { PromptSchema } from './prompt-schema';
import { toStringArray } from './prompt-schema';
import { buildStyleFingerprint, type StyleFingerprint } from './fingerprint';
import type { ReferencePreprocessSummary } from './reference-preprocess';

export type StyleSchemaLintSeverity = 'info' | 'warning' | 'error';

export interface StyleSchemaLintIssue {
  path: string;
  type: 'shape' | 'conflict' | 'style_drift_risk' | 'autofix';
  severity: StyleSchemaLintSeverity;
  message: string;
  current_value?: unknown;
  suggested_value?: unknown;
}

export interface StyleSchemaLintResult<T = unknown> {
  schema: T;
  issues: StyleSchemaLintIssue[];
  fingerprint: StyleFingerprint;
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneRecord<T>(value: T): T {
  if (!isRecord(value)) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureGroup(root: AnyRecord, key: string): AnyRecord {
  if (!isRecord(root[key])) root[key] = {};
  return root[key] as AnyRecord;
}

function readString(root: AnyRecord, groupKey: string, fieldKey: string): string {
  const group = root[groupKey];
  if (!isRecord(group)) return '';
  const value = group[fieldKey];
  return typeof value === 'string' ? value : '';
}

function setField(root: AnyRecord, groupKey: string, fieldKey: string, value: unknown) {
  const group = ensureGroup(root, groupKey);
  group[fieldKey] = value;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      }
    } catch {
      // Fall through to loose splitting.
    }
  }
  return toStringArray(value).map((item) => item.replace(/^\[?"?|"?\]?$/g, '').trim()).filter(Boolean);
}

function includesAny(value: string, needles: string[]): boolean {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function addIssue(
  issues: StyleSchemaLintIssue[],
  issue: StyleSchemaLintIssue,
) {
  issues.push(issue);
}

function setArray(root: AnyRecord, groupKey: string, fieldKey: string, values: string[]) {
  const group = ensureGroup(root, groupKey);
  group[fieldKey] = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function appendArray(root: AnyRecord, groupKey: string, fieldKey: string, values: string[]) {
  const group = ensureGroup(root, groupKey);
  const current = parseStringArray(group[fieldKey]);
  setArray(root, groupKey, fieldKey, [...current, ...values]);
}

function removeArrayItems(root: AnyRecord, groupKey: string, fieldKey: string, values: string[]) {
  const group = ensureGroup(root, groupKey);
  const removals = values.map((value) => value.toLowerCase());
  group[fieldKey] = parseStringArray(group[fieldKey]).filter((value) => !removals.includes(value.toLowerCase()));
}

function normalizeArrayFields(root: AnyRecord, issues: StyleSchemaLintIssue[]) {
  const fields: Array<[string, string]> = [
    ['color_palette', 'dominant_colors'],
    ['negative_prompt', 'avoid_elements'],
    ['negative_prompt', 'avoid_styles'],
    ['negative_prompt', 'avoid_artifacts'],
    ['negative_prompt', 'avoid_quality'],
  ];

  for (const [groupKey, fieldKey] of fields) {
    const group = root[groupKey];
    if (!isRecord(group) || !(fieldKey in group)) continue;
    const before = group[fieldKey];
    const after = parseStringArray(before);
    if (!Array.isArray(before)) {
      group[fieldKey] = after;
      addIssue(issues, {
        path: `${groupKey}.${fieldKey}`,
        type: 'shape',
        severity: 'warning',
        message: 'Coerced a non-array field into a string array so downstream prompt code is stable.',
        current_value: before,
        suggested_value: after,
      });
    }
  }
}

function fixTransparentBackgroundConflicts(root: AnyRecord, summary: ReferencePreprocessSummary | null | undefined, issues: StyleSchemaLintIssue[]) {
  const referenceLooksTransparent = Boolean(summary?.hasAnyAlpha || summary?.dominantAssetFormat === 'transparent_sticker');
  if (!referenceLooksTransparent) return;

  const checks: Array<[string, string, string]> = [
    ['environment', 'setting', 'Minimal transparent or plain light sticker asset setting'],
    ['environment', 'background_elements', 'Transparent or plain off-white background with minimal decorative motifs; never draw checkerboard transparency previews'],
    ['composition', 'negative_space', 'Clean open transparent or plain light negative space around the compact asset cluster'],
  ];

  for (const [groupKey, fieldKey, suggested] of checks) {
    const current = readString(root, groupKey, fieldKey);
    if (!current || includesAny(current, ['solid black', 'black background', 'abstract void', 'real room', 'cafe', 'interior', 'checkerboard'])) {
      setField(root, groupKey, fieldKey, suggested);
      addIssue(issues, {
        path: `${groupKey}.${fieldKey}`,
        type: 'conflict',
        severity: 'warning',
        message: 'Reference images appear to be transparent/isolated assets, so the background rule was corrected away from scene/black-background/checkerboard language.',
        current_value: current || null,
        suggested_value: suggested,
      });
    }
  }
}

function fixOverstrictNoFill(root: AnyRecord, issues: StyleSchemaLintIssue[]) {
  const current = readString(root, 'artistic_style', 'rendering_style');
  if (!current) return;
  if (!includesAny(current, ['no solid color fills', 'no solid fills', 'strictly no solid'])) return;

  const suggested = current.replace(/strictly\s+no\s+solid\s+color\s+fills|no\s+solid\s+color\s+fills|no\s+solid\s+fills/gi, 'pastel fills are allowed when overlaid with fine colored hatching; avoid large untextured solid fills');
  setField(root, 'artistic_style', 'rendering_style', suggested);
  addIssue(issues, {
    path: 'artistic_style.rendering_style',
    type: 'style_drift_risk',
    severity: 'warning',
    message: 'Reference sticker/vector styles often use pastel fills plus hatching; a hard “no fills” rule can push the model toward the wrong engraving style.',
    current_value: current,
    suggested_value: suggested,
  });
}

function isIntentionalNonFlatStyle(combined: string): boolean {
  return includesAny(combined, [
    'glossy 3d',
    '3d render',
    '3-d render',
    'cgi',
    'blender',
    'octane',
    'glassmorphism',
    'plastic toy',
    'shiny material',
    'photorealistic',
    'photoreal',
    'realistic photograph',
    'watercolor',
    'watercolour',
    'oil painting',
    'painterly wash',
    'anime',
    'cel shaded',
    'pixel art',
  ]);
}

function fixGlossAndSoftIconDrift(root: AnyRecord, summary: ReferencePreprocessSummary | null | undefined, issues: StyleSchemaLintIssue[]) {
  const combined = [
    readString(root, 'lighting', 'ambient_light'),
    readString(root, 'lighting', 'light_quality'),
    readString(root, 'lighting', 'special_lighting_effects'),
    readString(root, 'color_palette', 'tonal_range'),
    readString(root, 'artistic_style', 'style_reference'),
    readString(root, 'artistic_style', 'rendering_style'),
    readString(root, 'material_texture', 'surface_finish'),
    readString(root, 'material_texture', 'primary_material'),
  ].join(' ');
  const flatIconLike = Boolean(
    summary?.hasAnyAlpha ||
    summary?.dominantAssetFormat === 'transparent_sticker' ||
    includesAny(combined, ['flat vector', 'vector icon', 'sticker', 'pastel icon', 'ui icon', 'app icon', 'flat 2d', 'line art icon']),
  );
  if (!flatIconLike || isIntentionalNonFlatStyle(combined)) return;

  const hasGlossRisk = includesAny(combined, [
    'soft diffuse',
    'ambient light',
    'highlight',
    'tonal range',
    'glow',
    'glass',
    'gloss',
    'translucent',
    'plastic',
    'gradient',
    'kawaii',
    'modern ui/ux',
  ]);
  if (!hasGlossRisk) return;

  const lighting = ensureGroup(root, 'lighting');
  const before = {
    ambient_light: lighting.ambient_light,
    light_quality: lighting.light_quality,
    special_lighting_effects: lighting.special_lighting_effects,
  };
  lighting.ambient_light = 'None; flat vector color only';
  lighting.light_quality = 'No physical lighting model; crisp flat 2D fills';
  lighting.special_lighting_effects = 'Strictly no glossy highlights, no glass orb, no translucent plastic, no airbrushed gradient, no glow';
  appendArray(root, 'negative_prompt', 'avoid_styles', [
    'generic soft pastel app icon',
    'glossy kawaii icon',
    'glass orb effect',
    'translucent plastic rendering',
    'airbrushed gradient',
    'large shiny highlight',
  ]);
  appendArray(root, 'negative_prompt', 'avoid_artifacts', ['blurred vector edges', 'semi-transparent outline']);
  appendArray(root, 'negative_prompt', 'avoid_quality', ['washed-out low-contrast icon', 'overly soft edges']);
  addIssue(issues, {
    path: 'lighting/negative_prompt',
    type: 'style_drift_risk',
    severity: 'warning',
    message: 'Soft lighting/gloss wording can make flat pastel sticker icons drift into glossy app-icon or glass/plastic styles.',
    current_value: before,
    suggested_value: {
      ambient_light: lighting.ambient_light,
      light_quality: lighting.light_quality,
      special_lighting_effects: lighting.special_lighting_effects,
    },
  });
}

function fixLowResArtifactDrift(root: AnyRecord, summary: ReferencePreprocessSummary | null | undefined, issues: StyleSchemaLintIssue[]) {
  if (!summary?.qualityReport?.hasLowResolutionReferences) return;

  const generation = ensureGroup(root, 'generation_params');
  const policy = isRecord(generation.reference_artifact_policy) ? generation.reference_artifact_policy : null;
  const policyTarget = typeof policy?.output_quality_target === 'string' ? policy.output_quality_target : '';
  const combined = [
    readString(root, 'style_name', ''),
    readString(root, 'artistic_style', 'medium'),
    readString(root, 'artistic_style', 'style_reference'),
    readString(root, 'artistic_style', 'rendering_style'),
    readString(root, 'artistic_style', 'surface_texture'),
    readString(root, 'material_texture', 'pattern_detail'),
    readString(root, 'technical_quality', 'resolution_quality'),
    readString(root, 'technical_quality', 'sharpness'),
  ].join(' ');
  const userConfirmedPixelArt = policyTarget === 'preserve_intentional_pixel_art' || includesAny(combined, ['intentional pixel-art', 'intentional pixel art', 'pixelation is intentional']);
  if (userConfirmedPixelArt) return;

  const pixelArtRisk = includesAny(combined, ['pixel art', 'pixel-art', '8-bit', '16-bit', 'pixel grid', 'pixelated', 'low resolution', 'low-resolution']);
  const avoidQuality = parseStringArray(ensureGroup(root, 'negative_prompt').avoid_quality).join(' ');
  const avoidArtifacts = parseStringArray(ensureGroup(root, 'negative_prompt').avoid_artifacts).join(' ');
  const forbidsCleanOutput = includesAny(`${avoidQuality} ${avoidArtifacts}`, ['high resolution', 'smooth gradients', 'anti-aliasing']);
  if (!pixelArtRisk && !forbidsCleanOutput) return;

  const before = {
    style_name: root.style_name,
    resolution_quality: readString(root, 'technical_quality', 'resolution_quality'),
    pattern_detail: readString(root, 'material_texture', 'pattern_detail'),
    avoid_quality: parseStringArray(ensureGroup(root, 'negative_prompt').avoid_quality),
    avoid_artifacts: parseStringArray(ensureGroup(root, 'negative_prompt').avoid_artifacts),
  };

  generation.reference_artifact_policy = {
    preserve_resolution_artifacts: false,
    preserve_pixelation: false,
    preserve_aliasing: false,
    preserve_compression_artifacts: false,
    output_quality_target: 'clean_high_resolution_reconstruction',
  };
  if (typeof root.style_name === 'string' && includesAny(root.style_name, ['pixel art', 'pixel-art', '8-bit', '16-bit'])) {
    root.style_name = 'Reference-Matched Clean Style';
  }
  setField(root, 'technical_quality', 'resolution_quality', 'Clean high-resolution reconstruction from low-resolution references; preserve intended style traits but do not preserve pixelation, aliasing, blur, compression, or low-res jaggedness unless user confirms pixel art.');
  setField(root, 'artistic_style', 'surface_texture', 'Preserve intentional texture only; do not preserve accidental pixel grid, jagged edges, or low-resolution source artifacts unless explicitly confirmed.');
  setField(root, 'material_texture', 'pattern_detail', 'Reference-matched intentional texture only; no accidental pixel grid from low-resolution source images.');
  removeArrayItems(root, 'negative_prompt', 'avoid_quality', ['High resolution', 'Smooth gradients']);
  removeArrayItems(root, 'negative_prompt', 'avoid_artifacts', ['Anti-aliasing']);
  appendArray(root, 'negative_prompt', 'avoid_artifacts', [
    'low-resolution source artifacts',
    'jagged upscale edges',
    'visible pixel grid unless explicitly requested',
    'checkerboard transparency pattern',
    'compression artifacts',
    'blurred upscale artifacts',
  ]);
  appendArray(root, 'negative_prompt', 'avoid_styles', ['accidental pixel-art conversion caused only by low-resolution references']);

  addIssue(issues, {
    path: 'reference_quality/artifact_policy',
    type: 'style_drift_risk',
    severity: 'warning',
    message: 'Low-resolution references can cause pixelation/aliasing/compression to be misread as style. Moved those traits into artifact policy unless user confirms intentional pixel art.',
    current_value: before,
    suggested_value: {
      reference_artifact_policy: generation.reference_artifact_policy,
      resolution_quality: readString(root, 'technical_quality', 'resolution_quality'),
      avoid_artifacts: parseStringArray(ensureGroup(root, 'negative_prompt').avoid_artifacts),
    },
  });
}

function reinforceStickerComposition(root: AnyRecord, summary: ReferencePreprocessSummary | null | undefined, issues: StyleSchemaLintIssue[]) {
  const stickerLike = Boolean(summary?.dominantAssetFormat === 'transparent_sticker' || summary?.hasAnyAlpha);
  if (!stickerLike) return;

  const framing = readString(root, 'composition', 'framing');
  if (!includesAny(framing, ['sticker', 'isolated', 'asset'])) {
    const suggested = 'Compact centered isolated sticker-style asset, with breathing room around the subject cluster';
    setField(root, 'composition', 'framing', suggested);
    addIssue(issues, {
      path: 'composition.framing',
      type: 'autofix',
      severity: 'info',
      message: 'Added sticker/isolated asset framing based on transparent reference images.',
      current_value: framing || null,
      suggested_value: suggested,
    });
  }

  appendArray(root, 'negative_prompt', 'avoid_elements', ['realistic room background', 'busy cafe interior', 'full poster scene', 'unrequested furniture', 'solid black background', 'checkerboard transparency pattern']);
}

function setPaletteFromReference(root: AnyRecord, summary: ReferencePreprocessSummary | null | undefined, issues: StyleSchemaLintIssue[]) {
  const colors = summary?.dominantColors?.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 8) || [];
  if (!colors.length) return;

  const palette = ensureGroup(root, 'color_palette');
  const current = parseStringArray(palette.dominant_colors);
  if (current.length === 0 || current.some((item) => !/^#[0-9a-f]{6}$/i.test(item))) {
    palette.dominant_colors = colors;
    addIssue(issues, {
      path: 'color_palette.dominant_colors',
      type: 'autofix',
      severity: 'info',
      message: 'Replaced vague palette text with detected reference HEX colors.',
      current_value: current,
      suggested_value: colors,
    });
  }
}

export function lintAndFixStyleSchema<T = unknown>(
  input: T,
  options: { referenceSummary?: ReferencePreprocessSummary | null } = {},
): StyleSchemaLintResult<T> {
  if (!isRecord(input)) {
    const fingerprint = buildStyleFingerprint(null, options.referenceSummary || null);
    return { schema: input, issues: [], fingerprint };
  }

  const schema = cloneRecord(input) as AnyRecord;
  const issues: StyleSchemaLintIssue[] = [];

  normalizeArrayFields(schema, issues);
  fixTransparentBackgroundConflicts(schema, options.referenceSummary, issues);
  fixOverstrictNoFill(schema, issues);
  fixGlossAndSoftIconDrift(schema, options.referenceSummary, issues);
  fixLowResArtifactDrift(schema, options.referenceSummary, issues);
  reinforceStickerComposition(schema, options.referenceSummary, issues);
  setPaletteFromReference(schema, options.referenceSummary, issues);

  const fingerprint = buildStyleFingerprint(schema as unknown as PromptSchema, options.referenceSummary || null);
  return {
    schema: schema as T,
    issues,
    fingerprint,
  };
}
