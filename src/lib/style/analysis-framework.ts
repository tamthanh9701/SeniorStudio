// Ported from Restyle commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae
// (src/lib/style-analysis-framework.ts). Logic intact.

export const STYLE_ANALYSIS_FRAMEWORK_VERSION = 'universal_style_axes_v1' as const;

export type StyleAxisRole = 'core' | 'supporting' | 'optional' | 'not_applicable' | 'unknown';

export type StylePropertyAxisId =
  | 'visual_family'
  | 'line_edge_system'
  | 'shape_language'
  | 'color_palette'
  | 'value_lighting'
  | 'material_rendering'
  | 'surface_texture'
  | 'composition_framing'
  | 'background_environment'
  | 'camera_perspective'
  | 'detail_density'
  | 'motion_effects'
  | 'post_processing'
  | 'negative_transfer';

export interface StylePropertyAxis {
  id: StylePropertyAxisId;
  label: string;
  purpose: string;
  output_rule: string;
}

export interface StyleAxisFinding {
  axis: StylePropertyAxisId;
  role: StyleAxisRole;
  evidence: string[];
  transfer_rule: string;
  forbidden_drift: string[];
  confidence: number;
}

export interface UniversalStyleAnalysisContract {
  version: typeof STYLE_ANALYSIS_FRAMEWORK_VERSION;
  detected_family_label: string;
  family_confidence: number;
  axes: StyleAxisFinding[];
  content_to_ignore: string[];
  must_preserve: string[];
  must_not_invent: string[];
  open_questions: string[];
}

export const UNIVERSAL_STYLE_ANALYSIS_AXES: StylePropertyAxis[] = [
  {
    id: 'visual_family',
    label: 'Visual family / rendering family',
    purpose: 'Identify the broad visual construction method without forcing it into a predefined category.',
    output_rule: 'Use a concise evidence-based label. If uncertain, use a custom descriptive label instead of guessing a fixed style family.',
  },
  {
    id: 'line_edge_system',
    label: 'Line / edge system',
    purpose: 'Determine whether edges, outlines, strokes, or linework are core to the style.',
    output_rule: 'Only make outline rules core when linework is visibly central to the reference style.',
  },
  {
    id: 'shape_language',
    label: 'Shape language / form construction',
    purpose: 'Describe how forms are simplified, realistic, geometric, organic, distorted, volumetric, symbolic, or pixel-blocked.',
    output_rule: 'Translate shape observations into reusable generation rules without copying reference-only objects.',
  },
  {
    id: 'color_palette',
    label: 'Color palette and color roles',
    purpose: 'Separate color identity from subject content and identify color roles when possible.',
    output_rule: 'Describe color roles, not just color names. Use HEX anchors only when available or detected.',
  },
  {
    id: 'value_lighting',
    label: 'Value, light, and shadow behavior',
    purpose: 'Capture whether lighting is physical, graphic, painterly, symbolic, or absent.',
    output_rule: 'Do not ban lighting/gloss globally; only forbid it when it contradicts the detected style family.',
  },
  {
    id: 'material_rendering',
    label: 'Material and rendering behavior',
    purpose: 'Describe how surfaces are rendered: matte, glossy, metallic, paper, pigment, plastic, fabric, natural, etc.',
    output_rule: 'Preserve intentional material behavior. Never flatten 3D or natural material unless the reference is flat.',
  },
  {
    id: 'surface_texture',
    label: 'Surface texture / mark-making',
    purpose: 'Capture texture grammar such as hatching, grain, brush marks, paper texture, pixel dithering, halftone, or clean smoothness.',
    output_rule: 'Specify placement and density. Do not convert texture from one family into another.',
  },
  {
    id: 'composition_framing',
    label: 'Composition and framing',
    purpose: 'Describe layout grammar independent of subject identity.',
    output_rule: 'Only force centered/isolated composition when the reference evidence supports it.',
  },
  {
    id: 'background_environment',
    label: 'Background / environment policy',
    purpose: 'Decide whether the background is a core style element or should remain plain/transparent.',
    output_rule: 'Do not remove scene backgrounds from scene-based styles; do not invent scenes for isolated assets.',
  },
  {
    id: 'camera_perspective',
    label: 'Camera / perspective / lens behavior',
    purpose: 'Capture perspective if relevant, especially for realistic, 3D, cinematic, or object-render styles.',
    output_rule: 'Mark this not_applicable for purely flat styles unless perspective is visibly part of the style.',
  },
  {
    id: 'detail_density',
    label: 'Detail density / complexity',
    purpose: 'Capture how much detail is expected and where it appears.',
    output_rule: 'Avoid copying reference-specific objects while preserving the style’s density and simplification level.',
  },
  {
    id: 'motion_effects',
    label: 'Motion and effects',
    purpose: 'Capture glow, speed lines, particles, sparkles, blur, smoke, aura, etc. as core or optional.',
    output_rule: 'Classify effects as core/supporting/optional/not_applicable. Do not make optional decorations mandatory.',
  },
  {
    id: 'post_processing',
    label: 'Post-processing / finish',
    purpose: 'Capture final finish such as grain, bloom, vignette, compression, sharpened edges, or film grade.',
    output_rule: 'Only include post-processing when visibly supported by reference evidence.',
  },
  {
    id: 'negative_transfer',
    label: 'Negative transfer / style drift risks',
    purpose: 'Identify what must not be transferred or invented.',
    output_rule: 'Separate content_to_ignore from forbidden visual drift. Do not ban a visual feature if it is core to the detected style family.',
  },
];

export function buildStyleAnalysisFrameworkInstruction(): string {
  const axes = UNIVERSAL_STYLE_ANALYSIS_AXES
    .map((axis, index) => `${index + 1}. ${axis.label}: ${axis.output_rule}`)
    .join(' ');

  return [
    `Use the ${STYLE_ANALYSIS_FRAMEWORK_VERSION} framework.`,
    'Do not start from a fixed style category. Start from visible evidence and analyze the reference images across universal style axes.',
    'For every axis, decide its role: core, supporting, optional, not_applicable, or unknown. A field is mandatory only when reference evidence makes it necessary.',
    'The detected family may be a standard family, a hybrid, or a custom descriptive label. Do not force the output into sticker, vector, 3D, watercolor, anime, or any other family if the evidence does not support it.',
    'When an axis is not applicable, say so rather than inventing constraints. For example, do not invent outline rules for natural images, and do not invent lens rules for flat icons.',
    'Separate reusable style properties from reference-only content. Reference-only objects, props, text, and motifs should go into content_to_ignore, not reusable style rules.',
    'Do not use broad mood labels as final rules. Translate them into observable properties such as line, shape, color role, material, lighting, texture, composition, background, camera, detail density, effects, and finish.',
    `Universal axes: ${axes}`,
  ].join(' ');
}

export function buildStyleAnalysisFrameworkContext() {
  return {
    version: STYLE_ANALYSIS_FRAMEWORK_VERSION,
    axes: UNIVERSAL_STYLE_ANALYSIS_AXES,
  };
}
