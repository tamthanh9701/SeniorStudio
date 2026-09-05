// Ported from Restyle commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae
// (src/lib/style-invariant-contract.ts). Import paths adjusted only.
import type { ReferencePreprocessSummary } from './reference-preprocess';
import type { StyleFingerprint } from './fingerprint';

export type StyleInvariantPriority = 'must' | 'should' | 'optional' | 'forbidden';
export type VisualStyleFamily =
  | 'transparent_sticker_icon'
  | 'flat_vector_icon'
  | 'glossy_3d'
  | 'watercolor'
  | 'photoreal'
  | 'anime_cel'
  | 'pixel_art'
  | 'line_art'
  | 'unknown';

export interface OutlineInvariant {
  primary_outline_color: string;
  secondary_outline_color?: string;
  stroke_weight: 'thin' | 'medium' | 'thick' | 'unknown';
  stroke_shape: string;
  line_consistency: string;
  forbidden: string[];
}

export interface FillInvariant {
  fill_type: 'flat_matte_pastel' | 'textured_flat' | 'soft_gradient' | 'glossy' | 'painterly' | 'photoreal_material' | 'pixel_blocks' | 'unknown';
  allowed_shading: string[];
  forbidden_shading: string[];
}

export interface TextureInvariant {
  pattern_type: string;
  density: 'none' | 'subtle' | 'medium' | 'heavy' | 'unknown';
  placement_rule: string;
}

export interface CompositionInvariant {
  layout: string;
  background_policy: string;
  object_scale: string;
}

export interface StyleInvariantContract {
  version: '1.0';
  visual_family: string;
  visual_family_id: VisualStyleFamily;
  must_match: string[];
  should_match: string[];
  optional_elements: string[];
  forbidden_elements: string[];
  outline_system: OutlineInvariant;
  fill_system: FillInvariant;
  texture_system: TextureInvariant;
  composition_system: CompositionInvariant;
  content_to_ignore: string[];
  evidence_notes: string[];
  confidence: number;
}

export interface StyleSchemaCriticIssue {
  path: string;
  severity: 'info' | 'warning' | 'error';
  type:
    | 'too_generic'
    | 'missing_invariant'
    | 'gloss_risk'
    | 'palette_risk'
    | 'optional_motif_overweighted'
    | 'content_leak_risk'
    | 'contradiction_risk';
  message: string;
  suggested_fix: string;
}

export interface StyleSchemaQualityScore {
  specificity: number;
  invariant_coverage: number;
  contradiction_risk: number;
  generation_stability_risk: number;
  overall: number;
  issues: StyleSchemaCriticIssue[];
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
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function combinedSchemaText(schema: unknown): string {
  if (!isRecord(schema)) return '';
  const chunks: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') chunks.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(schema);
  return chunks.join(' ').toLowerCase();
}

function includesAny(value: string, needles: string[]): boolean {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function unique(items: string[], limit = 24): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function isFlatIconFamily(family: VisualStyleFamily): boolean {
  return family === 'transparent_sticker_icon' || family === 'flat_vector_icon';
}

function isOutlineDependentFamily(family: VisualStyleFamily): boolean {
  return isFlatIconFamily(family) || family === 'anime_cel' || family === 'line_art';
}

function detectVisualFamily(schema: unknown, fingerprint?: StyleFingerprint | null, summary?: ReferencePreprocessSummary | null): VisualStyleFamily {
  const textBlob = combinedSchemaText(schema);
  if (summary?.dominantAssetFormat === 'transparent_sticker' || fingerprint?.composition_grammar.format === 'compact_isolated_sticker') {
    return 'transparent_sticker_icon';
  }
  if (includesAny(textBlob, ['pixel art', '8-bit', '16-bit', 'sprite', 'pixelated'])) return 'pixel_art';
  if (includesAny(textBlob, ['photoreal', 'photo-real', 'realistic photograph', 'camera lens', 'dslr', 'cinematic photography'])) return 'photoreal';
  if (includesAny(textBlob, ['watercolor', 'watercolour', 'gouache wash', 'paper texture', 'paint bleed'])) return 'watercolor';
  if (includesAny(textBlob, ['anime', 'manga', 'cel shade', 'cel-shaded', 'lineart anime'])) return 'anime_cel';
  if (includesAny(textBlob, ['3d', '3-d', 'cgi', 'octane', 'blender', 'clay render', 'plastic toy', 'glassmorphism', 'glossy render', 'shiny material'])) return 'glossy_3d';
  if (includesAny(textBlob, ['line art', 'ink drawing', 'monoline', 'sketch lines', 'engraving'])) return 'line_art';
  if (includesAny(textBlob, ['flat vector', 'vector icon', 'ui icon', 'sticker', 'pastel icon', 'app icon', 'isolated icon'])) return 'flat_vector_icon';
  if (fingerprint?.background_policy.type === 'transparent_or_plain_light' && includesAny(textBlob, ['vector', 'icon', 'sticker'])) return 'flat_vector_icon';
  return 'unknown';
}

function inferOutlineColors(schema: unknown, fingerprint?: StyleFingerprint | null): { primary: string; secondary?: string } {
  const colors = unique([
    ...(fingerprint?.palette_system.detected_hex || []),
    ...list(schema, 'color_palette', 'dominant_colors'),
  ]).filter((color) => /^#[0-9a-f]{6}$/i.test(color));
  const textBlob = combinedSchemaText(schema);
  const primary = includesAny(textBlob, ['magenta', 'pink outline', 'pink outer', 'hồng', 'viền hồng'])
    ? 'magenta/pink primary contour'
    : colors[0] || 'primary visible line/color system from reference';
  const secondary = includesAny(textBlob, ['blue', 'xanh']) || colors.length > 1
    ? colors[1] || 'secondary accent line/color from reference'
    : undefined;
  return { primary, secondary };
}

function inferStrokeWeight(schema: unknown, fingerprint?: StyleFingerprint | null): OutlineInvariant['stroke_weight'] {
  const textBlob = combinedSchemaText(schema);
  if (includesAny(textBlob, ['thick', 'bold outline', 'đậm', 'stroke weight'])) return 'thick';
  if (includesAny(fingerprint?.line_system.outer_contour || '', ['thick', 'bold'])) return 'thick';
  if (includesAny(textBlob, ['thin', 'fine outline'])) return 'thin';
  if (includesAny(textBlob, ['outline', 'contour', 'stroke', 'line art'])) return 'medium';
  return 'unknown';
}

function inferFillType(schema: unknown, family: VisualStyleFamily): FillInvariant['fill_type'] {
  const textBlob = combinedSchemaText(schema);
  if (family === 'photoreal') return 'photoreal_material';
  if (family === 'watercolor') return 'painterly';
  if (family === 'pixel_art') return 'pixel_blocks';
  if (family === 'glossy_3d') return 'glossy';
  if (includesAny(textBlob, ['gloss', 'glass', 'shiny', 'plastic'])) return isFlatIconFamily(family) ? 'soft_gradient' : 'glossy';
  if (includesAny(textBlob, ['gradient', 'soft diffuse', 'airbrush'])) return 'soft_gradient';
  if (includesAny(textBlob, ['hatching', 'stripe', 'line pattern', 'parallel line', 'texture'])) return 'textured_flat';
  if (includesAny(textBlob, ['flat', 'matte', 'pastel', 'vector'])) return 'flat_matte_pastel';
  return 'unknown';
}

function inferTextureDensity(fingerprint?: StyleFingerprint | null): TextureInvariant['density'] {
  switch (fingerprint?.line_system.hatching_density) {
    case 'none': return 'none';
    case 'low': return 'subtle';
    case 'medium': return 'medium';
    case 'medium_high': return 'medium';
    case 'high': return 'heavy';
    default: return 'unknown';
  }
}

function inferOptionalElements(schema: unknown): string[] {
  const background = text(schema, 'environment', 'background_elements');
  const atmosphere = text(schema, 'mood_atmosphere', 'atmosphere_effects');
  const optional: string[] = [];
  if (includesAny(`${background} ${atmosphere}`, ['sparkle', 'star', 'magic'])) optional.push('tiny decorative sparkle/star accents only when useful');
  if (includesAny(combinedSchemaText(schema), ['line pattern', 'horizontal stripe', 'hatching'])) optional.push('subtle line texture in selected fill areas');
  return optional;
}

function inferContentToIgnore(schema: unknown, fingerprint?: StyleFingerprint | null): string[] {
  const mainSubject = text(schema, 'subject', 'main_subject');
  const details = text(schema, 'subject', 'subject_details');
  const objectDetails = [
    text(schema, 'subject_object', 'interaction'),
    text(schema, 'subject_object', 'arrangement_layout'),
  ].join(' ');
  const candidates = unique([
    ...(fingerprint?.reference_content_to_ignore || []),
    ...`${mainSubject} ${details} ${objectDetails}`
      .split(/,|;|\(|\)|\be\.g\.\b/i)
      .map((item) => item.trim())
      .filter((item) => item.length > 8),
  ], 12);
  return candidates.length ? candidates : ['specific reference objects or props unless the new brief requests them'];
}

function familyDisplayName(family: VisualStyleFamily, schema: unknown, fingerprint?: StyleFingerprint | null): string {
  switch (family) {
    case 'transparent_sticker_icon': return 'crisp pastel vector sticker object icon';
    case 'flat_vector_icon': return 'flat vector icon / sticker illustration';
    case 'glossy_3d': return 'glossy 3D / rendered object style';
    case 'watercolor': return 'watercolor / painterly wash illustration';
    case 'photoreal': return 'photorealistic image style';
    case 'anime_cel': return 'anime / cel-shaded illustration style';
    case 'pixel_art': return 'pixel art sprite style';
    case 'line_art': return 'line art / ink illustration style';
    default: return fingerprint?.style_family || text(schema, 'artistic_style', 'style_reference') || 'reusable visual style';
  }
}

function buildFamilyRules(params: {
  family: VisualStyleFamily;
  schema: unknown;
  fingerprint?: StyleFingerprint | null;
  outlineColors: { primary: string; secondary?: string };
  strokeWeight: OutlineInvariant['stroke_weight'];
  fillType: FillInvariant['fill_type'];
  textureDensity: TextureInvariant['density'];
}) {
  const { family, outlineColors, strokeWeight, fillType, textureDensity, fingerprint, schema } = params;
  if (isFlatIconFamily(family)) {
    return {
      must: [
        family === 'transparent_sticker_icon' ? 'single isolated object/icon asset on white or transparent/plain light background' : 'flat isolated vector/icon composition from reference',
        `${strokeWeight === 'unknown' ? 'consistent' : strokeWeight} crisp colored outer contour`,
        `${outlineColors.primary} as the dominant outline language`,
        'flat matte pastel fill behavior',
        'clean 2D orthographic/vector shape language',
        'low visual noise and simplified object details',
      ],
      should: [
        outlineColors.secondary ? `${outlineColors.secondary} only as a secondary/accent line system` : 'limited secondary accent colors only where present in references',
        textureDensity !== 'none' ? 'subtle internal line texture/hatching in selected fill areas' : 'minimal interior detail lines only when needed',
        'high edge contrast between colored outline and pastel fills',
        'full object visible with breathing room',
      ],
      forbidden: [
        'generic soft pastel app icon look',
        'glossy glass orb effect',
        'translucent plastic rendering',
        'large shiny highlights or airbrushed gradients',
        'washed-out low-contrast colors',
        'realistic lighting, shadows, or 3D rendering',
        'busy scene background or room/interior/cafe setting',
      ],
      fill: {
        fill_type: fillType === 'textured_flat' ? 'textured_flat' as const : 'flat_matte_pastel' as const,
        allowed_shading: ['flat color blocks', 'subtle line texture/hatching when present in reference', 'small hard-edged highlight only if graphic/vector-like'],
        forbidden_shading: ['glossy highlight', 'glass transparency', 'airbrushed gradient', 'soft glow', 'realistic light falloff'],
      },
      texturePlacement: 'apply texture only inside selected fill areas; do not turn texture into broad glossy bands or transparent strips',
    };
  }

  if (family === 'glossy_3d') {
    return {
      must: ['preserve 3D volume and object form', 'intentional glossy/material highlights', 'consistent studio/render lighting', 'material-specific reflections or smooth surfaces when present'],
      should: ['keep silhouettes clean and readable', 'match the reference camera angle and object scale', 'preserve material finish rather than flattening into vector art'],
      forbidden: ['flat matte vector simplification', 'cartoon sticker outline unless present in reference', 'washed-out low-contrast render', 'painterly watercolor bleed'],
      fill: {
        fill_type: 'glossy' as const,
        allowed_shading: ['controlled specular highlights', 'soft reflections', '3D material gradients', 'ambient occlusion when present'],
        forbidden_shading: ['flat vector-only fills', 'random airbrush haze unrelated to material', 'paper texture'],
      },
      texturePlacement: 'texture follows 3D material surfaces and lighting; do not replace material with flat vector stripes',
    };
  }

  if (family === 'watercolor') {
    return {
      must: ['preserve watercolor/painterly wash behavior', 'visible pigment variation or paper texture', 'soft organic edges where present', 'hand-painted feel'],
      should: ['keep palette and value relationships from reference', 'allow irregular brush boundaries', 'avoid overly perfect vector geometry'],
      forbidden: ['crisp flat vector sticker style', 'glossy 3D render', 'plastic material highlights', 'hard uniform outlines unless present in reference'],
      fill: {
        fill_type: 'painterly' as const,
        allowed_shading: ['pigment granulation', 'paper texture', 'soft washes', 'edge blooms when present'],
        forbidden_shading: ['flat plastic fill', 'uniform vector fill', 'CGI specular highlights'],
      },
      texturePlacement: 'texture should read as paper/pigment, not stripe pattern or digital gloss',
    };
  }

  if (family === 'photoreal') {
    return {
      must: ['preserve realistic material response', 'physically plausible lighting and shadows', 'natural camera/lens perspective', 'real-world surface detail'],
      should: ['match focal length/depth cues from reference when available', 'keep color grading realistic', 'avoid stylized simplification'],
      forbidden: ['flat vector icon style', 'cartoon outline', 'anime cel shading', 'watercolor texture unless present'],
      fill: {
        fill_type: 'photoreal_material' as const,
        allowed_shading: ['realistic light falloff', 'contact shadows', 'material texture', 'natural highlights'],
        forbidden_shading: ['flat matte icon fill', 'synthetic sticker outline', 'pixel-art dithering'],
      },
      texturePlacement: 'texture follows real material and camera detail, not decorative icon patterns',
    };
  }

  if (family === 'anime_cel') {
    return {
      must: ['preserve anime/cel-shaded linework', 'clean character/object silhouette', 'controlled flat shadow shapes', 'stylized proportions from reference'],
      should: ['use crisp line hierarchy', 'keep cel-shading boundaries intentional', 'preserve palette and expression language'],
      forbidden: ['photorealistic skin/materials', 'watercolor bleed', 'generic 3D render', 'washed-out pastel app icon drift'],
      fill: {
        fill_type: includesAny(combinedSchemaText(schema), ['gradient']) ? 'soft_gradient' as const : 'flat_matte_pastel' as const,
        allowed_shading: ['flat cel-shade blocks', 'clean shadow shapes', 'limited soft gradient only if reference uses it'],
        forbidden_shading: ['photorealistic rendering', 'random airbrush gloss', 'paper bleed'],
      },
      texturePlacement: 'line and shade placement follows cel-animation logic; no decorative sticker texture unless present',
    };
  }

  if (family === 'pixel_art') {
    return {
      must: ['preserve pixel grid readability', 'hard square pixel edges', 'limited palette clusters', 'sprite-scale silhouette clarity'],
      should: ['use intentional dithering only when present', 'avoid subpixel blur', 'keep object readable at small scale'],
      forbidden: ['anti-aliased vector smoothness', 'photoreal detail', 'soft watercolor edge', 'glossy high-resolution 3D render'],
      fill: {
        fill_type: 'pixel_blocks' as const,
        allowed_shading: ['blocky cluster shading', 'limited dithering', 'hard color steps'],
        forbidden_shading: ['blurred gradients', 'smooth vector fills', 'realistic soft shadows'],
      },
      texturePlacement: 'texture is expressed as pixel clusters/dithering only, never soft blur',
    };
  }

  if (family === 'line_art') {
    return {
      must: ['preserve line-driven construction', 'line weight and stroke rhythm from reference', 'minimal fill behavior unless present', 'clear contour hierarchy'],
      should: ['keep hatching/engraving density consistent', 'avoid over-coloring if reference is line-only', 'maintain edge crispness'],
      forbidden: ['glossy 3D material rendering', 'photoreal texture', 'soft watercolor wash unless present', 'generic app icon fill'],
      fill: {
        fill_type: fillType === 'textured_flat' ? 'textured_flat' as const : 'unknown' as const,
        allowed_shading: ['hatching', 'cross-hatching', 'contour lines', 'minimal flat fill if present'],
        forbidden_shading: ['CGI gloss', 'airbrushed gradients', 'plastic material effects'],
      },
      texturePlacement: 'texture follows line/hatching grammar, not broad glossy bands',
    };
  }

  return {
    must: ['preserve the dominant visual construction method from reference', 'separate reusable style from reference-only content', 'keep composition and palette behavior consistent with references'],
    should: ['translate broad art labels into concrete line/fill/texture/composition rules', 'preserve reference-specific rendering constraints when clearly detected'],
    forbidden: ['copying unrelated reference-only objects', 'mixing in a different rendering family without user request'],
    fill: {
      fill_type: fillType,
      allowed_shading: ['shading behavior that is directly supported by the reference'],
      forbidden_shading: ['shading or material effects not supported by the reference'],
    },
    texturePlacement: 'texture placement should follow reference evidence, not generic style assumptions',
  };
}

export function buildStyleInvariantContract(params: {
  schema: unknown;
  fingerprint?: StyleFingerprint | null;
  referenceSummary?: ReferencePreprocessSummary | null;
}): StyleInvariantContract {
  const { schema, fingerprint, referenceSummary } = params;
  const textBlob = combinedSchemaText(schema);
  const family = detectVisualFamily(schema, fingerprint, referenceSummary);
  const outlineColors = inferOutlineColors(schema, fingerprint);
  const strokeWeight = inferStrokeWeight(schema, fingerprint);
  const fillType = inferFillType(schema, family);
  const textureDensity = inferTextureDensity(fingerprint);
  const optionalElements = inferOptionalElements(schema);
  const familyRules = buildFamilyRules({ family, schema, fingerprint, outlineColors, strokeWeight, fillType, textureDensity });

  const evidence: string[] = [];
  if (referenceSummary?.hasAnyAlpha || referenceSummary?.dominantAssetFormat) {
    evidence.push(`reference asset format: ${referenceSummary.dominantAssetFormat || 'unknown'}, alpha=${referenceSummary.hasAnyAlpha}`);
  }
  if (fingerprint?.palette_system.detected_hex?.length) {
    evidence.push(`detected palette: ${fingerprint.palette_system.detected_hex.join(', ')}`);
  }
  if (fingerprint?.line_system.hatching_density && fingerprint.line_system.hatching_density !== 'unknown') {
    evidence.push(`line texture density: ${fingerprint.line_system.hatching_density}`);
  }
  if (family !== 'unknown') evidence.push(`detected visual family: ${family}`);

  const confidenceSignals = [
    family !== 'unknown',
    strokeWeight !== 'unknown' || !isOutlineDependentFamily(family),
    fillType !== 'unknown',
    Boolean(fingerprint?.palette_system.detected_hex?.length),
    textureDensity !== 'unknown',
  ].filter(Boolean).length;

  return {
    version: '1.0',
    visual_family: familyDisplayName(family, schema, fingerprint),
    visual_family_id: family,
    must_match: unique(familyRules.must),
    should_match: unique(familyRules.should),
    optional_elements: optionalElements.length ? optionalElements : ['decorative motifs only if they appear in the reference and do not dominate'],
    forbidden_elements: unique(familyRules.forbidden),
    outline_system: {
      primary_outline_color: isOutlineDependentFamily(family) ? outlineColors.primary : 'not a required invariant unless visible in reference',
      secondary_outline_color: isOutlineDependentFamily(family) ? outlineColors.secondary : undefined,
      stroke_weight: isOutlineDependentFamily(family) ? strokeWeight : 'unknown',
      stroke_shape: includesAny(textBlob, ['rounded']) ? 'rounded caps and joins' : 'stroke shape only if reference visibly depends on it',
      line_consistency: isOutlineDependentFamily(family)
        ? 'uniform crisp stroke behavior from reference; no blurred, semi-transparent, or low-contrast edges'
        : 'linework is secondary unless the reference makes it a visible style invariant',
      forbidden: isOutlineDependentFamily(family)
        ? ['line weight drift', 'blurred edges', 'semi-transparent contour', 'generic black outline unless reference requires it']
        : ['inventing cartoon/vector outlines when reference is not outline-driven'],
    },
    fill_system: familyRules.fill,
    texture_system: {
      pattern_type: family === 'watercolor'
        ? 'paper/pigment texture'
        : family === 'pixel_art'
          ? 'pixel clusters or dithering'
          : includesAny(textBlob, ['horizontal'])
            ? 'subtle horizontal/parallel line pattern'
            : 'texture from reference only',
      density: textureDensity,
      placement_rule: familyRules.texturePlacement,
    },
    composition_system: {
      layout: isFlatIconFamily(family) ? 'centered isolated icon/sticker asset' : fingerprint?.composition_grammar.framing || 'reference-matched composition',
      background_policy: fingerprint?.background_policy.type || (isFlatIconFamily(family) ? 'transparent_or_plain_light' : 'reference-matched'),
      object_scale: text(schema, 'subject', 'size_scale') || 'match reference scale/composition, with full object visible if icon/asset style',
    },
    content_to_ignore: inferContentToIgnore(schema, fingerprint),
    evidence_notes: evidence.length ? evidence : ['derived from schema text; direct visual evidence unavailable in deterministic pass'],
    confidence: clamp01(0.45 + confidenceSignals * 0.1),
  };
}

function addIssue(issues: StyleSchemaCriticIssue[], issue: StyleSchemaCriticIssue) {
  issues.push(issue);
}

export function critiqueStyleSchema(params: {
  schema: unknown;
  contract: StyleInvariantContract;
}): StyleSchemaQualityScore {
  const { schema, contract } = params;
  const textBlob = combinedSchemaText(schema);
  const family = contract.visual_family_id;
  const issues: StyleSchemaCriticIssue[] = [];

  const genericTerms = ['modern ui/ux', 'kawaii', 'playful', 'friendly', 'various conceptual icons', 'modern', 'cute'];
  const genericCount = genericTerms.filter((term) => textBlob.includes(term)).length;
  if (genericCount >= 2 && isFlatIconFamily(family)) {
    addIssue(issues, {
      path: 'artistic_style/style_reference/mood fields',
      severity: 'warning',
      type: 'too_generic',
      message: 'Schema contains broad icon-style labels that can fan out into multiple icon styles.',
      suggested_fix: `Replace broad labels with concrete invariants: ${contract.must_match.slice(0, 4).join('; ')}.`,
    });
  }

  const hasOutline = includesAny(textBlob, ['outline', 'contour', 'stroke', 'line art', 'linework']);
  const hasFill = includesAny(textBlob, ['flat', 'matte', 'pastel', 'fill', 'material', 'wash', 'pigment', 'photoreal', 'gloss', 'pixel']);
  const hasComposition = includesAny(textBlob, ['isolated', 'centered', 'white background', 'transparent', 'sticker', 'scene', 'camera', 'sprite', 'composition']);
  const hasAntiGloss = includesAny(textBlob, ['no glossy', 'without glossy', 'no glass', 'no glow', 'no translucent', 'matte']);
  const hasTexturePlacement = includesAny(textBlob, ['selected fill', 'some fills', 'subtle', 'horizontal line', 'hatching', 'paper texture', 'pixel', 'material texture', 'brush']);

  if (isOutlineDependentFamily(family) && !hasOutline) {
    addIssue(issues, {
      path: 'artistic_style.rendering_style',
      severity: 'error',
      type: 'missing_invariant',
      message: 'Schema does not lock the line/outline system strongly enough for an outline-driven style.',
      suggested_fix: contract.outline_system.line_consistency,
    });
  }
  if (!hasFill) {
    addIssue(issues, {
      path: 'material_texture/color_palette',
      severity: 'warning',
      type: 'missing_invariant',
      message: 'Schema does not lock fill/material behavior for the detected style family.',
      suggested_fix: contract.fill_system.allowed_shading.join(', '),
    });
  }
  if (isFlatIconFamily(family) && !hasComposition) {
    addIssue(issues, {
      path: 'composition/environment',
      severity: 'warning',
      type: 'missing_invariant',
      message: 'Schema does not strongly preserve isolated icon/sticker composition.',
      suggested_fix: contract.composition_system.layout,
    });
  }

  if (isFlatIconFamily(family) && includesAny(textBlob, ['soft diffuse', 'ambient light', 'highlight', 'tonal range', 'glow', 'glass', 'translucent']) && !hasAntiGloss) {
    addIssue(issues, {
      path: 'lighting/material_texture/negative_prompt',
      severity: 'warning',
      type: 'gloss_risk',
      message: 'Lighting or material wording may trigger glossy/soft app-icon drift for flat vector icon styles.',
      suggested_fix: contract.fill_system.forbidden_shading.join(', '),
    });
  }

  const dominantColors = list(schema, 'color_palette', 'dominant_colors');
  const hasHex = dominantColors.some((color) => /^#[0-9a-f]{6}$/i.test(color));
  if (!hasHex && contract.outline_system.primary_outline_color.startsWith('#')) {
    addIssue(issues, {
      path: 'color_palette.dominant_colors',
      severity: 'info',
      type: 'palette_risk',
      message: 'Palette lacks explicit HEX anchors for the detected color system.',
      suggested_fix: 'Store palette anchors from the reference and separate outline/material/fill roles when applicable.',
    });
  }

  if (isFlatIconFamily(family) && includesAny(text(schema, 'environment', 'background_elements'), ['sparkle', 'star']) && !textBlob.includes('optional')) {
    addIssue(issues, {
      path: 'environment.background_elements',
      severity: 'info',
      type: 'optional_motif_overweighted',
      message: 'Decorative sparkles/stars may be treated as core style rather than optional accent.',
      suggested_fix: 'Mark sparkles/stars as optional small accent motifs, not required background content.',
    });
  }

  const invariantSignals = [
    !isOutlineDependentFamily(family) || hasOutline,
    hasFill,
    !isFlatIconFamily(family) || hasComposition,
    !isFlatIconFamily(family) || hasAntiGloss,
    hasTexturePlacement,
  ].filter(Boolean).length;
  const specificity = clamp01(0.35 + invariantSignals * 0.12 - (isFlatIconFamily(family) ? genericCount * 0.04 : 0));
  const invariantCoverage = clamp01(invariantSignals / 5);
  const contradictionRisk = clamp01((issues.filter((issue) => issue.type === 'gloss_risk' || issue.type === 'contradiction_risk').length * 0.35) + (genericCount >= 2 && isFlatIconFamily(family) ? 0.15 : 0));
  const generationStabilityRisk = clamp01(1 - ((specificity + invariantCoverage) / 2) + contradictionRisk * 0.25);
  const overall = clamp01((specificity * 0.35) + (invariantCoverage * 0.45) + ((1 - contradictionRisk) * 0.1) + ((1 - generationStabilityRisk) * 0.1));

  return {
    specificity,
    invariant_coverage: invariantCoverage,
    contradiction_risk: contradictionRisk,
    generation_stability_risk: generationStabilityRisk,
    overall,
    issues,
  };
}

export function buildInvariantExtractionInstruction(): string {
  return [
    'Before producing PromptSchema, internally identify the visual style family first: flat vector/sticker, glossy 3D, watercolor, photoreal, anime/cel, pixel art, line art, or another family.',
    'Do not force every style into a flat vector icon. For glossy 3D, photoreal, watercolor, anime, or pixel art references, preserve their own material, lighting, edge, texture, and composition logic.',
    'Then identify: content_to_ignore, must-match style invariants, should-match traits, optional motifs, and forbidden effects for that detected family.',
    'Do not describe reference content as reusable style. Shopping carts, bags, trees, furniture, people count, props, and other specific objects are content_to_ignore unless the user explicitly requests them.',
    'Translate broad labels such as kawaii, modern UI/UX, playful, cute, or app icon into concrete visual rules for outline, fill, texture, palette, and composition when the detected family is an icon/sticker style.',
    'For isolated icon/sticker references, strongly preserve: centered isolated object, full object visible, plain white/transparent background, crisp colored vector outline, matte pastel fills, and no scene background.',
    'For glossy/3D references, preserve intentional specular highlights, material reflections, volume, and render lighting instead of forbidding them.',
    'For watercolor/painterly references, preserve pigment, paper texture, organic edges, and wash behavior instead of forcing crisp vector lines.',
    'Classify decorative sparkles/stars as optional motifs unless they are repeated core construction elements across the reference set.',
    'The final schema must contain concrete, generation-stable invariants for the detected family, not just mood words.',
  ].join(' ');
}
