import { z } from "zod";

import {
  AiOperationSchema,
  GenerationCountSchema,
  SupportedModelIdSchema,
  SupportedQualitySchema,
  SupportedSizeSchema,
} from "@/db/ai-jobs";
import { StyleError } from "./errors";
import {
  STYLE_GROUPS,
  SUBJECT_GROUPS,
  buildStyleGenerationPrompt,
  createEmptyPrompt,
  negativePromptToText,
  type PromptSchema,
} from "./prompt-schema";

const nullableText = z.string().nullable();
const nullableNumber = z.number().nullable();

const SubjectSchema = z.object({
  main_subject: nullableText,
  quantity: nullableText,
  subject_details: nullableText,
  size_scale: nullableText,
  orientation_placement: nullableText,
}).strict();

const SubjectCharacterSchema = z.object({
  pose_action: nullableText,
  expression_emotion: nullableText,
  clothing_accessories: nullableText,
  body_features: nullableText,
  hair_style: nullableText,
  age_appearance: nullableText,
  ethnicity_skin_tone: nullableText,
}).strict();

const SubjectObjectSchema = z.object({
  object_state: nullableText,
  object_condition: nullableText,
  brand_label: nullableText,
  arrangement_layout: nullableText,
  interaction: nullableText,
}).strict();

const EnvironmentSchema = z.object({
  setting: nullableText,
  location_type: nullableText,
  time_of_day: nullableText,
  weather: nullableText,
  season: nullableText,
  era_time_period: nullableText,
  background_elements: nullableText,
  foreground_elements: nullableText,
  ground_surface: nullableText,
  sky_description: nullableText,
}).strict();

const CompositionSchema = z.object({
  framing: nullableText,
  camera_angle: nullableText,
  perspective: nullableText,
  depth_of_field: nullableText,
  focal_point: nullableText,
  composition_rule: nullableText,
  symmetry: nullableText,
  negative_space: nullableText,
  crop_style: nullableText,
}).strict();

const LightingSchema = z.object({
  primary_light_source: nullableText,
  light_direction: nullableText,
  light_quality: nullableText,
  light_color_temperature: nullableText,
  shadow_type: nullableText,
  shadow_intensity: nullableText,
  special_lighting_effects: nullableText,
  ambient_light: nullableText,
  light_count: nullableText,
}).strict();

const ColorPaletteSchema = z.object({
  dominant_colors: z.array(z.string()).nullable(),
  color_scheme_type: nullableText,
  saturation_level: nullableText,
  contrast_level: nullableText,
  color_mood: nullableText,
  color_grading: nullableText,
  tonal_range: nullableText,
}).strict();

const ArtisticStyleSchema = z.object({
  medium: nullableText,
  art_movement: nullableText,
  style_reference: nullableText,
  surface_texture: nullableText,
  rendering_style: nullableText,
  level_of_abstraction: nullableText,
}).strict();

const MoodAtmosphereSchema = z.object({
  overall_mood: nullableText,
  narrative_context: nullableText,
  energy_level: nullableText,
  atmosphere_effects: nullableText,
  emotional_tone: nullableText,
}).strict();

const MaterialTextureSchema = z.object({
  primary_material: nullableText,
  secondary_material: nullableText,
  surface_finish: nullableText,
  reflectivity: nullableText,
  transparency: nullableText,
  pattern_detail: nullableText,
  wear_aging: nullableText,
}).strict();

const TechnicalQualitySchema = z.object({
  resolution_quality: nullableText,
  detail_level: nullableText,
  sharpness: nullableText,
  noise_grain: nullableText,
  render_engine: nullableText,
}).strict();

const CameraLensSchema = z.object({
  lens_type: nullableText,
  aperture: nullableText,
  shutter_speed_effect: nullableText,
  iso_effect: nullableText,
  film_stock: nullableText,
  filter_on_lens: nullableText,
}).strict();

const PostProcessingSchema = z.object({
  vignette: nullableText,
  bloom_glow: nullableText,
  chromatic_aberration: nullableText,
  lens_distortion: nullableText,
  color_filter: nullableText,
  grain_overlay: nullableText,
  sharpening: nullableText,
}).strict();

const NegativePromptSchema = z.object({
  avoid_elements: z.array(z.string()),
  avoid_styles: z.array(z.string()),
  avoid_artifacts: z.array(z.string()),
  avoid_quality: z.array(z.string()),
}).strict();

const GenerationParamsSchema = z.object({
  aspect_ratio: nullableText,
  seed: nullableNumber,
  steps: nullableNumber,
  cfg_scale: nullableNumber,
  sampler: nullableText,
  model_recommendation: nullableText,
}).strict();

export const PromptSchemaSchema: z.ZodType<PromptSchema> = z.object({
  schema_version: z.number().optional(),
  style_name: z.string(),
  version: z.string(),
  subject_type: z.enum([
    "character", "object", "scene", "architecture", "food", "vehicle",
    "animal", "nature", "abstract", "product", "other",
  ]),
  subject: SubjectSchema,
  subject_character: SubjectCharacterSchema.nullable(),
  subject_object: SubjectObjectSchema.nullable(),
  environment: EnvironmentSchema,
  composition: CompositionSchema,
  lighting: LightingSchema,
  color_palette: ColorPaletteSchema,
  artistic_style: ArtisticStyleSchema,
  mood_atmosphere: MoodAtmosphereSchema,
  material_texture: MaterialTextureSchema,
  technical_quality: TechnicalQualitySchema,
  camera_lens: CameraLensSchema,
  post_processing: PostProcessingSchema,
  negative_prompt: NegativePromptSchema,
  generation_params: GenerationParamsSchema,
}).strict();

const EffectiveContentSchema = z.object({
  subject: SubjectSchema,
  subject_character: SubjectCharacterSchema.nullable(),
  subject_object: SubjectObjectSchema.nullable(),
  environment: EnvironmentSchema,
  composition: CompositionSchema,
}).strict();

const ReferenceSnapshotSchema = z.object({
  id: z.string().uuid(),
  content_hash: z.string().nullable(),
}).strict();

const EditSchema = z.object({
  target: z.string().min(1),
  instruction: z.string(),
}).strict();

/** Durable, provider-independent generation provenance stored with style jobs and versions. */
export const StyleGenerationPacketSchema = z.object({
  packet_version: z.literal(1),
  style_id: z.string().uuid(),
  style_revision: z.string(),
  schema_snapshot: PromptSchemaSchema,
  operation: AiOperationSchema,
  original_prompt: z.string(),
  effective_content: EffectiveContentSchema,
  compiled_prompt: z.string().min(1).max(8000),
  reference_snapshot: z.array(ReferenceSnapshotSchema),
  source_version_id: z.string().uuid().nullable(),
  edit: EditSchema.nullable(),
  model: SupportedModelIdSchema,
  size: SupportedSizeSchema,
  quality: SupportedQualitySchema,
  count: GenerationCountSchema,
  metadata: z.object({ style_provenance: z.enum(["current_style_fallback"]).optional() }).optional(),
}).strict();

export type StyleGenerationPacket = z.infer<typeof StyleGenerationPacketSchema>;
export type StyleContentOverrides = z.infer<typeof ContentOverridesSchema>;

export interface CompileStyleGenerationPacketInput {
  styleId: string;
  styleRevision: string;
  schema: PromptSchema;
  originalPrompt: string;
  contentOverrides?: StyleContentOverrides | Record<string, unknown> | null;
  references: ReadonlyArray<{ id: string; content_hash: string | null }>;
  operation: StyleGenerationPacket["operation"];
  sourceVersionId?: string | null;
  sourcePacket?: StyleGenerationPacket | null;
  editTarget?: string | null;
  model: StyleGenerationPacket["model"];
  size: StyleGenerationPacket["size"];
  quality: StyleGenerationPacket["quality"];
  count: StyleGenerationPacket["count"];
  useCurrentStyle?: boolean;
  sourceOriginalPrompt?: string | null;
}

const CONTENT_GROUP_SCHEMAS = {
  subject: SubjectSchema.partial().strict(),
  subject_character: SubjectCharacterSchema.partial().strict().nullable(),
  subject_object: SubjectObjectSchema.partial().strict().nullable(),
  environment: EnvironmentSchema.partial().strict(),
  composition: CompositionSchema.partial().strict(),
};

export const ContentOverridesSchema = z.object(CONTENT_GROUP_SCHEMAS).partial().strict();
const EMPTY_SCHEMA = createEmptyPrompt();
const GROUP_FIELD_ORDER = Object.fromEntries(
  [...STYLE_GROUPS, ...SUBJECT_GROUPS].map((group) => [
    group,
    Object.keys(EMPTY_SCHEMA[group] ?? {}),
  ]),
) as Record<string, string[]>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseContentOverrides(value: unknown): StyleContentOverrides {
  const parsed = ContentOverridesSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new StyleError("STYLE_CONFLICT", "Content overrides may only set typed fields in subject groups");
  }
  return parsed.data as StyleContentOverrides;
}

function mergeContent(
  base: StyleGenerationPacket["effective_content"],
  overrides: StyleContentOverrides,
): StyleGenerationPacket["effective_content"] {
  const result = clone(base);
  for (const group of SUBJECT_GROUPS) {
    const override = overrides[group as keyof StyleContentOverrides];
    if (override === undefined) continue;
    if (override === null) {
      if (group !== "subject_character" && group !== "subject_object") {
        throw new StyleError("STYLE_CONFLICT", `Content group '${group}' cannot be null`);
      }
      (result as Record<string, unknown>)[group] = null;
      continue;
    }
    const current = (result as Record<string, unknown>)[group] as Record<string, unknown> | null;
    if (!current) {
      (result as Record<string, unknown>)[group] = clone(override);
    } else {
      (result as Record<string, unknown>)[group] = { ...current, ...clone(override) };
    }
  }
  return result;
}

function contentFromSchema(schema: PromptSchema): StyleGenerationPacket["effective_content"] {
  return {
    subject: clone(schema.subject),
    subject_character: clone(schema.subject_character),
    subject_object: clone(schema.subject_object),
    environment: clone(schema.environment),
    composition: clone(schema.composition),
  };
}

function formatValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return items.length ? items.join(", ") : null;
  }
  return null;
}

function renderGroups(
  groups: readonly (keyof PromptSchema)[],
  source: Partial<PromptSchema> | StyleGenerationPacket["effective_content"],
): string[] {
  const sourceRecord = source as Record<string, unknown>;
  const lines: string[] = [];
  for (const group of groups) {
    const record = sourceRecord[group];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    for (const field of GROUP_FIELD_ORDER[group] ?? []) {
      const value = formatValue((record as Record<string, unknown>)[field]);
      if (value) lines.push(`${group}.${field}: ${value}`);
    }
  }
  return lines;
}

function assertEditTarget(target: string): void {
  const [group, field, ...rest] = target.split(".");
  if (rest.length || !SUBJECT_GROUPS.includes(group as keyof PromptSchema)) {
    throw new StyleError("STYLE_CONFLICT", `Edit target '${target}' is not a subject field`);
  }
  if (!(GROUP_FIELD_ORDER[group] ?? []).includes(field)) {
    throw new StyleError("STYLE_CONFLICT", `Edit target '${target}' does not exist`);
  }
}

function applyEdit(
  content: StyleGenerationPacket["effective_content"],
  target: string,
  instruction: string,
): void {
  assertEditTarget(target);
  const [group, field] = target.split(".");
  let record = content[group as keyof typeof content];
  if (record === null) {
    record = {} as never;
    content[group as keyof typeof content] = record as never;
  }
  (record as unknown as Record<string, unknown>)[field] = instruction;
}

function compilePrompt(params: {
  schema: PromptSchema;
  content: StyleGenerationPacket["effective_content"];
  references: StyleGenerationPacket["reference_snapshot"];
  edit: StyleGenerationPacket["edit"];
}): string {
  const styleFields = renderGroups(STYLE_GROUPS, params.schema);
  const styleCapsule = buildStyleGenerationPrompt(params.schema, Number.MAX_SAFE_INTEGER);
  const negativePrompt = negativePromptToText(params.schema.negative_prompt);
  const sections = [
    ["STYLE", styleCapsule, ...styleFields, negativePrompt ? `negative_prompt: ${negativePrompt}` : null],
    ["CONTENT", ...renderGroups(SUBJECT_GROUPS, params.content)],
    [
      "REFERENCES",
      ...(params.references.length
        ? params.references.map((reference) => `${reference.id} (${reference.content_hash ?? "hash unavailable"})`)
        : ["none"]),
    ],
    ...(params.edit ? [["EDIT", `${params.edit.target}: ${params.edit.instruction}`]] : []),
  ];

  return sections
    .map((section) => section.filter((line): line is string => typeof line === "string").join("\n"))
    .join("\n\n");
}

/** Compile an immutable style generation packet without I/O or implicit truncation. */
export function compileStyleGenerationPacket(
  input: CompileStyleGenerationPacketInput,
): StyleGenerationPacket {
  const sourcePacket = input.sourcePacket
    ? StyleGenerationPacketSchema.parse(input.sourcePacket)
    : null;
  const fallbackToCurrent = input.operation === "inpaint" && !sourcePacket && input.useCurrentStyle === true;
  if (input.operation === "inpaint" && !sourcePacket && !fallbackToCurrent) {
    throw new StyleError("STYLE_CONFLICT", "Inpaint requires the source generation packet snapshot; pass useCurrentStyle=true for current style fallback");
  }
  if (sourcePacket && sourcePacket.style_id !== input.styleId) {
    throw new StyleError("STYLE_CONFLICT", "Source packet belongs to a different style group");
  }

  const snapshot = sourcePacket ? clone(sourcePacket.schema_snapshot) : clone(input.schema);
  const baseContent = sourcePacket
    ? clone(sourcePacket.effective_content)
    : contentFromSchema(snapshot);
  const overrides = parseContentOverrides(input.contentOverrides);
  const effectiveContent = mergeContent(baseContent, overrides);

  let originalPrompt = sourcePacket?.original_prompt ?? input.originalPrompt;
  let edit: StyleGenerationPacket["edit"] = null;
  if (input.operation === "inpaint") {
    const target = input.editTarget ?? "subject.subject_details";
    edit = { target, instruction: input.originalPrompt };
    applyEdit(effectiveContent, target, input.originalPrompt);
    if (fallbackToCurrent) {
      originalPrompt = input.sourceOriginalPrompt ?? "";
    }
  } else {
    effectiveContent.subject.main_subject = input.originalPrompt;
    originalPrompt = input.originalPrompt;
  }

  const references = input.references.map((reference) => ({
    id: reference.id,
    content_hash: reference.content_hash,
  }));
  const compiledPrompt = compilePrompt({ schema: snapshot, content: effectiveContent, references, edit });
  if (compiledPrompt.length > 8000) {
    throw new StyleError("PROMPT_TOO_LONG", "Compiled style prompt exceeds 8000 characters; shorten the content or style schema");
  }

  return StyleGenerationPacketSchema.parse({
    packet_version: 1,
    style_id: input.styleId,
    style_revision: sourcePacket?.style_revision ?? input.styleRevision,
    schema_snapshot: snapshot,
    operation: input.operation,
    original_prompt: originalPrompt,
    effective_content: effectiveContent,
    compiled_prompt: compiledPrompt,
    reference_snapshot: references,
    source_version_id: input.sourceVersionId ?? null,
    edit,
    model: input.model,
    size: input.size,
    quality: input.quality,
    count: input.count,
    metadata: fallbackToCurrent ? { style_provenance: "current_style_fallback" } : undefined,
  });
}
