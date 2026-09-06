// Analysis prompts ported from Restyle commit dfab2fe
// (ai-actions.ts ANALYZE_STYLE_SYSTEM + style-analysis-runner.ts EXTRACTION_RULES,
// REQUIRED_SCHEMA_FOCUS, summarizeReferencePreprocess, pickAiPromptSchema).
import {
  buildStyleAnalysisFrameworkContext,
  buildStyleAnalysisFrameworkInstruction,
  STYLE_ANALYSIS_FRAMEWORK_VERSION,
} from "../analysis-framework";
import { buildInvariantExtractionInstruction } from "../invariant-contract";
import type { ReferencePreprocessSummary } from "../reference-preprocess";

export const ANALYZE_STYLE_SYSTEM = `You are an expert image analysis AI. Your task is to analyze the visual style of the provided images and generate a comprehensive structured JSON prompt that captures every aspect of the style.

You MUST respond with ONLY a valid JSON object matching this exact structure. For any aspect not clearly present in the images, set the value to null. DO NOT include any explanation or markdown, just the raw JSON.

The JSON structure:
{
  "style_name": "string - a descriptive name for this style",
  "version": "1.0",
  "subject_type": "character | object | scene | architecture | food | vehicle | animal | nature | abstract | product | other",
  "subject": { "main_subject": "string|null", "quantity": "string|null", "subject_details": "string|null", "size_scale": "string|null", "orientation_placement": "string|null" },
  "subject_character": { "pose_action": "string|null", "expression_emotion": "string|null", "clothing_accessories": "string|null", "body_features": "string|null", "hair_style": "string|null", "age_appearance": "string|null", "ethnicity_skin_tone": "string|null" },
  "subject_object": { "object_state": "string|null", "object_condition": "string|null", "brand_label": "string|null", "arrangement_layout": "string|null", "interaction": "string|null" },
  "environment": { "setting": "string|null", "location_type": "string|null", "time_of_day": "string|null", "weather": "string|null", "season": "string|null", "era_time_period": "string|null", "background_elements": "string|null", "foreground_elements": "string|null", "ground_surface": "string|null", "sky_description": "string|null" },
  "composition": { "framing": "string|null", "camera_angle": "string|null", "perspective": "string|null", "depth_of_field": "string|null", "focal_point": "string|null", "composition_rule": "string|null", "symmetry": "string|null", "negative_space": "string|null", "crop_style": "string|null" },
  "lighting": { "primary_light_source": "string|null", "light_direction": "string|null", "light_quality": "string|null", "light_color_temperature": "string|null", "shadow_type": "string|null", "shadow_intensity": "string|null", "special_lighting_effects": "string|null", "ambient_light": "string|null", "light_count": "string|null" },
  "color_palette": { "dominant_colors": ["array of color names or hex codes"], "color_scheme_type": "string|null", "saturation_level": "string|null", "contrast_level": "string|null", "color_mood": "string|null", "color_grading": "string|null", "tonal_range": "string|null" },
  "artistic_style": { "medium": "string|null", "art_movement": "string|null", "style_reference": "string|null", "surface_texture": "string|null", "rendering_style": "string|null", "level_of_abstraction": "string|null" },
  "mood_atmosphere": { "overall_mood": "string|null", "narrative_context": "string|null", "energy_level": "string|null", "atmosphere_effects": "string|null", "emotional_tone": "string|null" },
  "material_texture": { "primary_material": "string|null", "secondary_material": "string|null", "surface_finish": "string|null", "reflectivity": "string|null", "transparency": "string|null", "pattern_detail": "string|null", "wear_aging": "string|null" },
  "technical_quality": { "resolution_quality": "string|null", "detail_level": "string|null", "sharpness": "string|null", "noise_grain": "string|null", "render_engine": "string|null" },
  "camera_lens": { "lens_type": "string|null", "aperture": "string|null", "shutter_speed_effect": "string|null", "iso_effect": "string|null", "film_stock": "string|null", "filter_on_lens": "string|null" },
  "post_processing": { "vignette": "string|null", "bloom_glow": "string|null", "chromatic_aberration": "string|null", "lens_distortion": "string|null", "color_filter": "string|null", "grain_overlay": "string|null", "sharpening": "string|null" },
  "negative_prompt": { "avoid_elements": ["array of strings"], "avoid_styles": ["array of strings"], "avoid_artifacts": ["array of strings"], "avoid_quality": ["array of strings"] },
  "generation_params": { "aspect_ratio": "string|null", "seed": null, "steps": null, "cfg_scale": null, "sampler": "string|null", "model_recommendation": "string|null" }
}`;

export const EXTRACTION_RULES = [
  buildStyleAnalysisFrameworkInstruction(),
  buildInvariantExtractionInstruction(),
  'Extract reusable visual style only; never start from a predetermined style family.',
  'For every schema field, first decide which universal style axis it belongs to and whether that axis is core, supporting, optional, not_applicable, or unknown.',
  'Only write hard constraints when they are supported by reference evidence or user context. If an axis is not applicable, do not invent a constraint for it.',
  'Do not copy reference-only content such as tree, popcorn, group size, furniture, shopping cart, bags, wheels, text, characters, props, or scene objects unless the user explicitly requests them.',
  'If references are transparent stickers or isolated assets, preserve that as background/composition policy. If references are scene-based, painterly, photographic, 3D, anime, pixel, or another family, preserve that family instead.',
  'Do not globally ban gloss, glass, lighting, shadows, texture, outlines, camera perspective, or backgrounds. Ban them only when they contradict the detected style family.',
  'Every final schema field must be phrased as an evidence-based generation rule, not a broad mood/style label.',
].join(' ');

const REQUIRED_SCHEMA_FOCUS: Record<string, string> = {
  visual_family: 'evidence-based family label; can be custom/hybrid and must not be forced into a fixed category',
  line_edge_system: 'only core if linework/edges visibly define the style; otherwise mark secondary or not applicable',
  shape_language: 'form construction and silhouette grammar independent of reference-only subjects',
  color_palette: 'color roles such as outline/fill/material/background/light/accent, not just color names',
  value_lighting: 'physical, graphic, painterly, symbolic, or absent lighting; preserve or forbid only according to evidence',
  material_rendering: 'surface/material behavior such as matte/glossy/metal/paper/pigment/plastic/natural if supported',
  surface_texture: 'texture type, density, and placement; avoid translating texture into the wrong family',
  composition_framing: 'layout, scale, negative space, crop, scene/asset policy based on evidence',
  background_environment: 'plain/transparent/studio/scene/abstract/paper/natural environment policy based on evidence',
  camera_perspective: 'orthographic/isometric/lens/cinematic/macro/top-down only when visible; otherwise not_applicable',
  detail_density: 'minimal/medium/dense/ornate/realistic/simplified detail density and where detail appears',
  motion_effects: 'glow/particles/sparkles/speed lines/blur/etc. classified as core/supporting/optional/not_applicable',
  post_processing: 'grain/bloom/vignette/film grade/sharpening/compression/finish only if visible',
  negative_transfer: 'content_to_ignore plus visual drift risks; do not ban features that are core to the detected style family',
};

export function summarizeReferencePreprocess(summary: ReferencePreprocessSummary | null) {
  if (!summary) return null;
  return {
    total: summary.total,
    ok: summary.ok,
    failed: summary.failed,
    hasAnyAlpha: summary.hasAnyAlpha,
    dominantAssetFormat: summary.dominantAssetFormat,
    dominantColors: summary.dominantColors.slice(0, 8),
    qualityReport: summary.qualityReport
      ? {
          hasLowResolutionReferences: summary.qualityReport.hasLowResolutionReferences,
          lowResolutionCount: summary.qualityReport.lowResolutionCount,
          pixelArtAmbiguity: summary.qualityReport.pixelArtAmbiguity,
          recommendedPolicy: summary.qualityReport.recommendedPolicy,
        }
      : null,
    warnings: summary.warnings.slice(0, 6),
  };
}

export function buildAnalysisUserMessage(params: {
  styleName: string;
  referenceCount: number;
  userContext?: string;
  referenceSummary: ReferencePreprocessSummary;
}): string {
  const { styleName, referenceCount, userContext, referenceSummary } = params;
  const promptContext = JSON.stringify({
    styleName,
    userContext: userContext || null,
    referencePreprocess: summarizeReferencePreprocess(referenceSummary),
    analysisProtocol: STYLE_ANALYSIS_FRAMEWORK_VERSION,
    framework: buildStyleAnalysisFrameworkContext(),
    extractionInstruction: EXTRACTION_RULES,
    requiredSchemaFocus: REQUIRED_SCHEMA_FOCUS,
  });
  return `Analyze the style of these ${referenceCount} image(s) for the reusable style profile "${styleName}". Context JSON:\n${promptContext}`;
}

/** Recognizes a PromptSchema shape, possibly wrapped in a { result } envelope. */
export function pickAiPromptSchema(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate =
    "style_name" in value || "subject_type" in value
      ? value
      : "result" in value && typeof value.result === "object" && value.result !== null
        ? value.result
        : null;
  if (!candidate || !("style_name" in candidate || "subject_type" in candidate)) return null;
  return candidate as Record<string, unknown>;
}

/** Strips a markdown fence, if present, and returns the inner JSON text. */
export function stripMarkdownFence(raw: string): string {
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (jsonMatch ? jsonMatch[1] : raw).trim();
}
