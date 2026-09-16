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
  background: z.literal("transparent").nullable().optional(),
  metadata: z
    .object({
      style_provenance: z.enum(["current_style_fallback"]).optional(),
      /** References borrowed from other styles in the same library, in the order they were sent. */
      library_reference_ids: z.array(z.string().uuid()).optional(),
    })
    .optional(),
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
  /** Subset of `references` that came from the library rather than this style. */
  libraryReferenceIds?: readonly string[];
  operation: StyleGenerationPacket["operation"];
  sourceVersionId?: string | null;
  sourcePacket?: StyleGenerationPacket | null;
  editTarget?: string | null;
  model: StyleGenerationPacket["model"];
  background?: "transparent" | null;
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

/**
 * Starting content for a brand new image.
 *
 * The analysed schema describes the reference images that defined the style;
 * copying its subject groups would leak that subject into every generation
 * (clay cats asked for a delivery truck would keep producing cats).  Only
 * explicit typed overrides and the user's own prompt seed the content.
 */
function emptyContent(): StyleGenerationPacket["effective_content"] {
  const blank = createEmptyPrompt();
  return contentFromSchema(blank);
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

/** Provenance metadata: undefined rather than an empty object when there is nothing to record. */
function buildPacketMetadata(
  adoptingCurrentStyle: boolean,
  libraryReferenceIds: readonly string[],
  references: ReadonlyArray<{ id: string }>,
): StyleGenerationPacket["metadata"] {
  const sent = new Set(references.map((reference) => reference.id));
  const libraryIds = libraryReferenceIds.filter((id) => sent.has(id));
  if (!adoptingCurrentStyle && libraryIds.length === 0) return undefined;
  return {
    ...(adoptingCurrentStyle ? { style_provenance: "current_style_fallback" as const } : {}),
    ...(libraryIds.length ? { library_reference_ids: [...libraryIds] } : {}),
  };
}

/**
 * The prompt a generation would compile to right now, for previewing an edit to
 * the schema before it is applied. Uses the confirmed reference set's shape; no
 * provider call, no packet.
 */
export function previewCompiledPrompt(params: {
  schema: Record<string, unknown>;
  references: ReadonlyArray<{ id: string; content_hash: string | null }>;
}): string {
  const schema = PromptSchemaSchema.parse(params.schema);
  const content = emptyContent();
  const references = params.references.map((reference) => ({ id: reference.id, content_hash: reference.content_hash }));
  return compilePrompt({ schema, content, references, edit: null });
}

/** Compile an immutable style generation packet without I/O or implicit truncation. */
export function compileStyleGenerationPacket(
  input: CompileStyleGenerationPacketInput,
): StyleGenerationPacket {
  const sourcePacket = input.sourcePacket
    ? StyleGenerationPacketSchema.parse(input.sourcePacket)
    : null;
  // A legacy source packet without references cannot authorise an edit: the
  // caller must either supply the original definition or adopt explicitly.
  const usableSource = sourcePacket !== null && sourcePacket.reference_snapshot.length > 0;
  const adoptingCurrentStyle = input.operation === "inpaint" && !usableSource && input.useCurrentStyle === true;
  if (input.operation === "inpaint" && !usableSource && !adoptingCurrentStyle) {
    throw new StyleError(
      "STYLE_SOURCE_SNAPSHOT_REQUIRED",
      "This image predates a recorded style definition; confirm whether to apply the current confirmed style",
    );
  }
  if (sourcePacket && sourcePacket.style_id !== input.styleId) {
    throw new StyleError("STYLE_CONFLICT", "Source packet belongs to a different style group");
  }

  // An edit is defined by its source image; every other operation is defined by
  // the confirmed definition supplied by the caller.  Chained edits therefore
  // keep the original style even after the style is revised.
  const sourceIsAuthority = input.operation === "inpaint" && usableSource;
  const snapshot = sourceIsAuthority ? clone(sourcePacket!.schema_snapshot) : clone(input.schema);

  let baseContent: StyleGenerationPacket["effective_content"];
  if (sourceIsAuthority) {
    baseContent = clone(sourcePacket!.effective_content);
  } else if (input.operation === "inpaint") {
    // Explicit adoption of the confirmed style: the original content is not
    // recoverable, so only the recorded subject line and the user's edit seed
    // the content.  The analysed reference subjects are never copied in.
    baseContent = emptyContent();
    if (input.sourceOriginalPrompt?.trim()) baseContent.subject.main_subject = input.sourceOriginalPrompt.trim();
  } else if (input.operation === "image_to_image" && sourcePacket) {
    baseContent = clone(sourcePacket.effective_content);
  } else if (input.operation === "image_to_image") {
    baseContent = contentFromSchema(snapshot);
  } else {
    baseContent = emptyContent();
  }
  const overrides = parseContentOverrides(input.contentOverrides);
  const effectiveContent = mergeContent(baseContent, overrides);

  // References follow the same authority as the schema: an edit reuses exactly
  // the references that produced the source image, a new image uses the
  // confirmed set.  A contradicting request is rejected, never merged.
  const requestedReferences = input.references.map((reference) => ({
    id: reference.id,
    content_hash: reference.content_hash,
  }));
  const references = sourceIsAuthority
    ? sourcePacket!.reference_snapshot.map((reference) => ({ ...reference }))
    : requestedReferences;
  if (sourceIsAuthority && requestedReferences.length > 0) {
    const expected = new Map(references.map((reference) => [reference.id, reference.content_hash ?? ""]));
    if (requestedReferences.some((reference) => expected.get(reference.id) !== (reference.content_hash ?? ""))) {
      throw new StyleError("STYLE_CONFLICT", "An edit must reuse the references recorded with the source image");
    }
  }
  if (references.length === 0) {
    throw new StyleError("STYLE_NOT_READY", "This style has no confirmed reference images");
  }

  let originalPrompt = sourceIsAuthority ? sourcePacket!.original_prompt : input.originalPrompt;
  let edit: StyleGenerationPacket["edit"] = null;
  if (input.operation === "inpaint") {
    const target = input.editTarget ?? "subject.subject_details";
    edit = { target, instruction: input.originalPrompt };
    applyEdit(effectiveContent, target, input.originalPrompt);
    if (adoptingCurrentStyle) {
      originalPrompt = input.sourceOriginalPrompt ?? "";
    }
  } else {
    effectiveContent.subject.main_subject = input.originalPrompt;
    originalPrompt = input.originalPrompt;
  }

  const compiledPrompt = compilePrompt({ schema: snapshot, content: effectiveContent, references, edit });
  if (compiledPrompt.length > 8000) {
    throw new StyleError("PROMPT_TOO_LONG", "Compiled style prompt exceeds 8000 characters; shorten the content or style schema");
  }

  return StyleGenerationPacketSchema.parse({
    packet_version: 1,
    style_id: input.styleId,
    style_revision: sourceIsAuthority ? sourcePacket!.style_revision : input.styleRevision,
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
    ...(input.background === "transparent" ? { background: "transparent" as const } : {}),
    metadata: buildPacketMetadata(adoptingCurrentStyle, input.libraryReferenceIds ?? [], references),
  });
}
