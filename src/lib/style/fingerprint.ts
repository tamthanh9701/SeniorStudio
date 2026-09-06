// Ported from Restyle commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae
// (src/lib/style-fingerprint.ts). Import path adjusted only.
import type { PromptSchema } from './prompt-schema';
import type { ReferencePreprocessSummary } from './reference-preprocess';

export type BackgroundPolicyType =
  | 'transparent_or_plain_light'
  | 'plain_light'
  | 'full_scene'
  | 'unknown';

export interface StyleFingerprint {
  version: '1.0';
  style_family: string;
  rendering_language: string;
  background_policy: {
    type: BackgroundPolicyType;
    forbid: string[];
  };
  line_system: {
    outer_contour: string;
    inner_detail: string;
    line_color_policy: string;
    hatching_density: 'none' | 'low' | 'medium' | 'medium_high' | 'high' | 'unknown';
  };
  fill_system: {
    allow_pastel_fills: boolean;
    texture_required: boolean;
    rule: string;
  };
  palette_system: {
    mode: 'monochrome' | 'duotone' | 'tritone' | 'limited_palette' | 'unknown';
    max_hue_families: number;
    detected_hex: string[];
    allow_user_palette_override: boolean;
  };
  composition_grammar: {
    format: 'compact_isolated_sticker' | 'isolated_asset' | 'full_canvas_scene' | 'unknown';
    subject_count: string;
    props: string;
    framing: string;
    forbid: string[];
  };
  reference_content_to_ignore: string[];
  hard_constraints: string[];
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function group(schema: unknown, key: string): AnyRecord {
  if (!isRecord(schema)) return {};
  const value = schema[key];
  return isRecord(value) ? value : {};
}

function text(schema: unknown, groupKey: string, key: string): string {
  const value = group(schema, groupKey)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function list(schema: unknown, groupKey: string, key: string): string[] {
  const value = group(schema, groupKey)[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function includesAny(value: string, needles: string[]): boolean {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function detectHatching(schema: unknown): StyleFingerprint['line_system']['hatching_density'] {
  const combined = [
    text(schema, 'artistic_style', 'rendering_style'),
    text(schema, 'artistic_style', 'surface_texture'),
    text(schema, 'material_texture', 'pattern_detail'),
    text(schema, 'lighting', 'shadow_type'),
  ].join(' ').toLowerCase();

  if (!combined) return 'unknown';
  if (includesAny(combined, ['dense hatching', 'dense cross-hatching', 'guilloche', 'banknote'])) return 'high';
  if (includesAny(combined, ['fine parallel', 'contour line', 'cross-hatching', 'hatching'])) return 'medium_high';
  if (includesAny(combined, ['line texture', 'engraving'])) return 'medium';
  return 'unknown';
}

function detectBackgroundPolicy(schema: unknown, summary?: ReferencePreprocessSummary): BackgroundPolicyType {
  if (summary?.hasAnyAlpha || summary?.dominantAssetFormat === 'transparent_sticker') return 'transparent_or_plain_light';
  const combined = [
    text(schema, 'environment', 'setting'),
    text(schema, 'environment', 'background_elements'),
    text(schema, 'composition', 'negative_space'),
  ].join(' ');
  if (includesAny(combined, ['transparent', 'plain light', 'off-white', 'clean open space'])) return 'transparent_or_plain_light';
  if (includesAny(combined, ['minimal', 'plain', 'clean background'])) return 'plain_light';
  if (includesAny(combined, ['room', 'cafe', 'landscape', 'interior', 'scene'])) return 'full_scene';
  return 'unknown';
}

function detectFormat(schema: unknown, summary?: ReferencePreprocessSummary): StyleFingerprint['composition_grammar']['format'] {
  if (summary?.dominantAssetFormat === 'transparent_sticker') return 'compact_isolated_sticker';
  if (summary?.dominantAssetFormat === 'isolated_asset') return 'isolated_asset';
  const combined = [
    text(schema, 'composition', 'framing'),
    text(schema, 'composition', 'crop_style'),
    text(schema, 'environment', 'setting'),
    text(schema, 'environment', 'background_elements'),
  ].join(' ');
  if (includesAny(combined, ['sticker', 'isolated', 'asset extraction', 'transparent'])) return 'compact_isolated_sticker';
  if (includesAny(combined, ['full canvas', 'scene', 'room', 'environment'])) return 'full_canvas_scene';
  return 'unknown';
}

function paletteMode(colorCount: number): StyleFingerprint['palette_system']['mode'] {
  if (colorCount <= 0) return 'unknown';
  if (colorCount === 1) return 'monochrome';
  if (colorCount === 2) return 'duotone';
  if (colorCount === 3) return 'tritone';
  return 'limited_palette';
}

export function buildStyleFingerprint(
  schema: PromptSchema | AnyRecord | null | undefined,
  summary?: ReferencePreprocessSummary | null,
): StyleFingerprint {
  const detectedHex = [
    ...(summary?.dominantColors || []),
    ...list(schema, 'color_palette', 'dominant_colors').filter((item) => /^#[0-9a-f]{6}$/i.test(item)),
  ];
  const uniqueHex = Array.from(new Set(detectedHex.map((item) => item.toUpperCase()))).slice(0, 8);
  const rendering = [
    text(schema, 'artistic_style', 'medium'),
    text(schema, 'artistic_style', 'rendering_style'),
    text(schema, 'artistic_style', 'style_reference'),
  ].filter(Boolean).join('; ');
  const hatching = detectHatching(schema);
  const backgroundType = detectBackgroundPolicy(schema, summary || undefined);
  const format = detectFormat(schema, summary || undefined);

  return {
    version: '1.0',
    style_family: format === 'compact_isolated_sticker'
      ? 'transparent promotional sticker vector'
      : text(schema, 'artistic_style', 'style_reference') || 'reusable visual style',
    rendering_language: rendering || 'colored vector illustration with consistent reusable line and texture rules',
    background_policy: {
      type: backgroundType,
      forbid: [
        'solid black background unless explicitly requested',
        'busy realistic room or cafe background unless explicitly requested',
        'deep perspective scene when the style is an isolated asset',
      ],
    },
    line_system: {
      outer_contour: 'clean colored outline, medium thickness',
      inner_detail: hatching === 'unknown' ? 'consistent interior detail lines' : 'fine parallel or contour hatching on major surfaces',
      line_color_policy: 'use colored lines that match the palette; avoid generic black ink unless the reference requires it',
      hatching_density: hatching,
    },
    fill_system: {
      allow_pastel_fills: true,
      texture_required: hatching !== 'none',
      rule: 'Pastel flat fills are allowed, but large surfaces should include line texture or hatching; avoid large clean untextured vector fills.',
    },
    palette_system: {
      mode: paletteMode(uniqueHex.length || 3),
      max_hue_families: 3,
      detected_hex: uniqueHex,
      allow_user_palette_override: true,
    },
    composition_grammar: {
      format,
      subject_count: 'Use the requested subject count; do not inherit people count from reference images.',
      props: 'Use 1-3 simple supporting props only when requested by the content brief.',
      framing: format === 'compact_isolated_sticker'
        ? 'compact centered sticker cluster with breathing room around the asset'
        : text(schema, 'composition', 'framing') || 'clear reusable centered composition',
      forbid: [
        'copying reference-specific objects that are not requested',
        'turning isolated sticker references into a full room or poster scene',
        'adding extra furniture or scenery when the brief asks for minimal background',
      ],
    },
    reference_content_to_ignore: [
      'holiday tree unless requested',
      'popcorn, cinema props, or movie reels unless requested',
      'group of people unless requested',
      'financial props, coins, or gift boxes unless requested',
    ],
    hard_constraints: [
      'Separate reusable style rules from one-off reference content.',
      'If a user provides a palette override, treat it as dominant and suppress unrelated accent colors.',
      'Keep background policy consistent with the reference asset format.',
    ],
  };
}

export function styleFingerprintToPrompt(fingerprint: StyleFingerprint): string {
  return [
    `Style format: ${fingerprint.composition_grammar.format}.`,
    `Rendering language: ${fingerprint.rendering_language}.`,
    `Background policy: ${fingerprint.background_policy.type}. Avoid: ${fingerprint.background_policy.forbid.join(', ')}.`,
    `Line system: ${fingerprint.line_system.outer_contour}; ${fingerprint.line_system.inner_detail}; ${fingerprint.line_system.line_color_policy}.`,
    `Fill system: ${fingerprint.fill_system.rule}`,
    `Palette system: ${fingerprint.palette_system.mode}; max ${fingerprint.palette_system.max_hue_families} hue families; detected colors ${fingerprint.palette_system.detected_hex.join(', ') || 'not available'}.`,
    `Composition: ${fingerprint.composition_grammar.framing}. Avoid: ${fingerprint.composition_grammar.forbid.join(', ')}.`,
    `Do not inherit reference-only content: ${fingerprint.reference_content_to_ignore.join(', ')}.`,
    `Hard constraints: ${fingerprint.hard_constraints.join(' ')}`,
  ].join('\n');
}
