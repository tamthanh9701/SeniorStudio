// Ported from Restyle (commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae)
// src/types/definitions.ts — subset referenced by the style engine. Logic intact.

export type SubjectType =
  | "character"
  | "object"
  | "scene"
  | "architecture"
  | "food"
  | "vehicle"
  | "animal"
  | "nature"
  | "abstract"
  | "product"
  | "other";

export interface SubjectGroup {
  main_subject: string | null;
  quantity: string | null;
  subject_details: string | null;
  size_scale: string | null;
  orientation_placement: string | null;
}

export interface SubjectCharacterGroup {
  pose_action: string | null;
  expression_emotion: string | null;
  clothing_accessories: string | null;
  body_features: string | null;
  hair_style: string | null;
  age_appearance: string | null;
  ethnicity_skin_tone: string | null;
}

export interface SubjectObjectGroup {
  object_state: string | null;
  object_condition: string | null;
  brand_label: string | null;
  arrangement_layout: string | null;
  interaction: string | null;
}

export interface EnvironmentGroup {
  setting: string | null;
  location_type: string | null;
  time_of_day: string | null;
  weather: string | null;
  season: string | null;
  era_time_period: string | null;
  background_elements: string | null;
  foreground_elements: string | null;
  ground_surface: string | null;
  sky_description: string | null;
}

export interface CompositionGroup {
  framing: string | null;
  camera_angle: string | null;
  perspective: string | null;
  depth_of_field: string | null;
  focal_point: string | null;
  composition_rule: string | null;
  symmetry: string | null;
  negative_space: string | null;
  crop_style: string | null;
}

export interface LightingGroup {
  primary_light_source: string | null;
  light_direction: string | null;
  light_quality: string | null;
  light_color_temperature: string | null;
  shadow_type: string | null;
  shadow_intensity: string | null;
  special_lighting_effects: string | null;
  ambient_light: string | null;
  light_count: string | null;
}

export interface ColorPaletteGroup {
  dominant_colors: string[] | null;
  color_scheme_type: string | null;
  saturation_level: string | null;
  contrast_level: string | null;
  color_mood: string | null;
  color_grading: string | null;
  tonal_range: string | null;
}

export interface ArtisticStyleGroup {
  medium: string | null;
  art_movement: string | null;
  style_reference: string | null;
  surface_texture: string | null;
  rendering_style: string | null;
  level_of_abstraction: string | null;
}

export interface MoodAtmosphereGroup {
  overall_mood: string | null;
  narrative_context: string | null;
  energy_level: string | null;
  atmosphere_effects: string | null;
  emotional_tone: string | null;
}

export interface MaterialTextureGroup {
  primary_material: string | null;
  secondary_material: string | null;
  surface_finish: string | null;
  reflectivity: string | null;
  transparency: string | null;
  pattern_detail: string | null;
  wear_aging: string | null;
}

export interface TechnicalQualityGroup {
  resolution_quality: string | null;
  detail_level: string | null;
  sharpness: string | null;
  noise_grain: string | null;
  render_engine: string | null;
}

export interface CameraLensGroup {
  lens_type: string | null;
  aperture: string | null;
  shutter_speed_effect: string | null;
  iso_effect: string | null;
  film_stock: string | null;
  filter_on_lens: string | null;
}

export interface PostProcessingGroup {
  vignette: string | null;
  bloom_glow: string | null;
  chromatic_aberration: string | null;
  lens_distortion: string | null;
  color_filter: string | null;
  grain_overlay: string | null;
  sharpening: string | null;
}

export interface NegativePromptGroup {
  avoid_elements: string[];
  avoid_styles: string[];
  avoid_artifacts: string[];
  avoid_quality: string[];
}

export interface GenerationParamsGroup {
  aspect_ratio: string | null;
  seed: number | null;
  steps: number | null;
  cfg_scale: number | null;
  sampler: string | null;
  model_recommendation: string | null;
}

export interface PromptSchema {
  schema_version?: number; // v2
  style_name: string;
  version: string;
  subject_type: SubjectType;

  subject: SubjectGroup;
  subject_character: SubjectCharacterGroup | null;
  subject_object: SubjectObjectGroup | null;
  environment: EnvironmentGroup;
  composition: CompositionGroup;
  lighting: LightingGroup;
  color_palette: ColorPaletteGroup;
  artistic_style: ArtisticStyleGroup;
  mood_atmosphere: MoodAtmosphereGroup;
  material_texture: MaterialTextureGroup;
  technical_quality: TechnicalQualityGroup;
  camera_lens: CameraLensGroup;
  post_processing: PostProcessingGroup;
  negative_prompt: NegativePromptGroup;
  generation_params: GenerationParamsGroup;
}

export function createEmptyPrompt(
  name: string = "Untitled Style",
  type: SubjectType = "character",
): PromptSchema {
  return {
    style_name: name,
    version: "1.0",
    subject_type: type,
    subject: {
      main_subject: null,
      quantity: null,
      subject_details: null,
      size_scale: null,
      orientation_placement: null,
    },
    subject_character: {
      pose_action: null,
      expression_emotion: null,
      clothing_accessories: null,
      body_features: null,
      hair_style: null,
      age_appearance: null,
      ethnicity_skin_tone: null,
    },
    subject_object: {
      object_state: null,
      object_condition: null,
      brand_label: null,
      arrangement_layout: null,
      interaction: null,
    },
    environment: {
      setting: null,
      location_type: null,
      time_of_day: null,
      weather: null,
      season: null,
      era_time_period: null,
      background_elements: null,
      foreground_elements: null,
      ground_surface: null,
      sky_description: null,
    },
    composition: {
      framing: null,
      camera_angle: null,
      perspective: null,
      depth_of_field: null,
      focal_point: null,
      composition_rule: null,
      symmetry: null,
      negative_space: null,
      crop_style: null,
    },
    lighting: {
      primary_light_source: null,
      light_direction: null,
      light_quality: null,
      light_color_temperature: null,
      shadow_type: null,
      shadow_intensity: null,
      special_lighting_effects: null,
      ambient_light: null,
      light_count: null,
    },
    color_palette: {
      dominant_colors: null,
      color_scheme_type: null,
      saturation_level: null,
      contrast_level: null,
      color_mood: null,
      color_grading: null,
      tonal_range: null,
    },
    artistic_style: {
      medium: null,
      art_movement: null,
      style_reference: null,
      surface_texture: null,
      rendering_style: null,
      level_of_abstraction: null,
    },
    mood_atmosphere: {
      overall_mood: null,
      narrative_context: null,
      energy_level: null,
      atmosphere_effects: null,
      emotional_tone: null,
    },
    material_texture: {
      primary_material: null,
      secondary_material: null,
      surface_finish: null,
      reflectivity: null,
      transparency: null,
      pattern_detail: null,
      wear_aging: null,
    },
    technical_quality: {
      resolution_quality: null,
      detail_level: null,
      sharpness: null,
      noise_grain: null,
      render_engine: null,
    },
    camera_lens: {
      lens_type: null,
      aperture: null,
      shutter_speed_effect: null,
      iso_effect: null,
      film_stock: null,
      filter_on_lens: null,
    },
    post_processing: {
      vignette: null,
      bloom_glow: null,
      chromatic_aberration: null,
      lens_distortion: null,
      color_filter: null,
      grain_overlay: null,
      sharpening: null,
    },
    negative_prompt: {
      avoid_elements: [],
      avoid_styles: [],
      avoid_artifacts: [],
      avoid_quality: [],
    },
    generation_params: {
      aspect_ratio: null,
      seed: null,
      steps: null,
      cfg_scale: null,
      sampler: null,
      model_recommendation: null,
    },
  };
}

// STYLE groups: Fixed parameters that define the visual style
// SUBJECT groups: Variable parameters that define image content

export const STYLE_GROUPS: (keyof PromptSchema)[] = [
  "artistic_style",
  "color_palette",
  "lighting",
  "mood_atmosphere",
  "material_texture",
  "technical_quality",
  "camera_lens",
  "post_processing",
  "negative_prompt",
  "generation_params",
];

export const SUBJECT_GROUPS: (keyof PromptSchema)[] = [
  "subject",
  "subject_character",
  "subject_object",
  "environment",
  "composition",
];

// Helper to check if a group belongs to Style or Subject
export function getGroupCategory(
  groupKey: keyof PromptSchema,
): "style" | "subject" | "meta" {
  if (STYLE_GROUPS.includes(groupKey)) return "style";
  if (SUBJECT_GROUPS.includes(groupKey)) return "subject";
  return "meta"; // style_name, version, subject_type
}

// Robust coercion for negative-prompt fields.
// avoid_* fields are declared as string[], but AI responses / legacy data can
// deliver a plain string, null, or other shapes. Anything that assumes an array
// (e.g. `.join(',')`) crashes ("x.join is not a function"). Coerce defensively.
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/** Flatten a (possibly malformed) negative_prompt group into a comma-joined string. */
export function negativePromptToText(neg: unknown): string {
  if (!neg || typeof neg !== "object") return "";
  const n = neg as Record<string, unknown>;
  return [
    ...toStringArray(n.avoid_elements),
    ...toStringArray(n.avoid_styles),
    ...toStringArray(n.avoid_artifacts),
    ...toStringArray(n.avoid_quality),
  ].join(", ");
}

function groupRecord(schema: unknown, groupKey: string): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return {};
  const group = (schema as Record<string, unknown>)[groupKey];
  return group && typeof group === "object" && !Array.isArray(group)
    ? (group as Record<string, unknown>)
    : {};
}

function textValue(group: Record<string, unknown>, key: string): string | null {
  const value = group[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function listValue(group: Record<string, unknown>, key: string): string | null {
  const values = toStringArray(group[key]);
  return values.length ? values.join(", ") : null;
}

function joinValues(...values: Array<string | null | undefined>): string | null {
  const clean = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return clean.length ? clean.join("; ") : null;
}

function capsuleSection(
  label: string,
  ...values: Array<string | null | undefined>
): string | null {
  const body = joinValues(...values);
  return body ? `${label}: ${body}.` : null;
}

function truncateAtWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const clipped = value.slice(0, Math.max(0, maxChars - 1));
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary > maxChars * 0.7 ? clipped.slice(0, boundary) : clipped).trim()}...`;
}

/**
 * Build a compact style capsule for image generation.
 *
 * The full PromptSchema is useful for editing and auditing, but repeating every
 * field in each image request wastes tokens and can leak old subject details
 * into new generations. This capsule keeps the durable visual rules and leaves
 * the variable subject/content to the CONTENT prompt.
 */
export function buildStyleGenerationPrompt(
  schema: PromptSchema | Record<string, unknown> | null | undefined,
  maxChars = 1800,
): string {
  if (!schema || typeof schema !== "object") return "Coherent reusable visual style.";

  const root = schema as Record<string, unknown>;
  const artistic = groupRecord(schema, "artistic_style");
  const palette = groupRecord(schema, "color_palette");
  const lighting = groupRecord(schema, "lighting");
  const material = groupRecord(schema, "material_texture");
  const composition = groupRecord(schema, "composition");
  const mood = groupRecord(schema, "mood_atmosphere");
  const quality = groupRecord(schema, "technical_quality");
  const lens = groupRecord(schema, "camera_lens");
  const post = groupRecord(schema, "post_processing");
  const neg = groupRecord(schema, "negative_prompt");

  const lines = [
    `Style capsule: ${typeof root.style_name === "string" && root.style_name.trim() ? root.style_name.trim() : "Untitled style"}.`,
    "Use these as visual rules only; do not copy the original subject, objects, genre, story, or scene content.",
    capsuleSection(
      "Rendering",
      textValue(artistic, "medium"),
      textValue(artistic, "rendering_style"),
      textValue(artistic, "art_movement"),
      textValue(artistic, "style_reference"),
      textValue(artistic, "level_of_abstraction"),
    ),
    capsuleSection(
      "Palette",
      listValue(palette, "dominant_colors"),
      textValue(palette, "color_scheme_type"),
      textValue(palette, "saturation_level"),
      textValue(palette, "contrast_level"),
      textValue(palette, "color_mood"),
      textValue(palette, "color_grading"),
    ),
    capsuleSection(
      "Lighting",
      textValue(lighting, "primary_light_source"),
      textValue(lighting, "light_direction"),
      textValue(lighting, "light_quality"),
      textValue(lighting, "light_color_temperature"),
      textValue(lighting, "shadow_type"),
      textValue(lighting, "shadow_intensity"),
      textValue(lighting, "ambient_light"),
    ),
    capsuleSection(
      "Material and texture",
      textValue(material, "primary_material"),
      textValue(material, "secondary_material"),
      textValue(material, "surface_finish"),
      textValue(material, "pattern_detail"),
      textValue(artistic, "surface_texture"),
      textValue(material, "wear_aging"),
    ),
    capsuleSection(
      "Composition",
      textValue(composition, "framing"),
      textValue(composition, "camera_angle"),
      textValue(composition, "perspective"),
      textValue(composition, "focal_point"),
      textValue(composition, "negative_space"),
      textValue(composition, "crop_style"),
    ),
    capsuleSection(
      "Mood",
      textValue(mood, "overall_mood"),
      textValue(mood, "energy_level"),
      textValue(mood, "atmosphere_effects"),
      textValue(mood, "emotional_tone"),
    ),
    capsuleSection(
      "Quality and finish",
      textValue(quality, "resolution_quality"),
      textValue(quality, "detail_level"),
      textValue(quality, "sharpness"),
      textValue(quality, "render_engine"),
      textValue(lens, "lens_type"),
      textValue(post, "bloom_glow"),
      textValue(post, "grain_overlay"),
      textValue(post, "sharpening"),
    ),
    capsuleSection(
      "Avoid style drift",
      listValue(neg, "avoid_elements"),
      listValue(neg, "avoid_styles"),
      listValue(neg, "avoid_artifacts"),
      listValue(neg, "avoid_quality"),
    ),
  ].filter((line): line is string => Boolean(line));

  return truncateAtWord(lines.join("\n"), maxChars);
}
