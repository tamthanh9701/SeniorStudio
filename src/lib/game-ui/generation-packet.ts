// Version 2 generation packets: what a Game UI screen or element was made from.
// The generic version 1 packet describes a scene subject; this one describes a
// requirement list or a single element, so it is a separate strict schema rather
// than extra keys inside the other one.
import { z } from "zod";

import { AiOperationSchema, GenerationCountSchema, SupportedModelIdSchema, SupportedQualitySchema, SupportedSizeSchema } from "@/db/ai-jobs";
import { GameUiError } from "./errors";
import { GameUiStyleSchemaV1, type GameUiStyleSchema } from "./style-schema";
import { GameUiElementSchema, ScreenSpecV1Schema, type ElementDocument, type ScreenSpec } from "./contracts";
import { KIND_DESCRIPTIONS, ORGANIZATIONAL_KINDS } from "./taxonomy";

export const GAME_UI_PACKET_VERSION = 2;
/** Longest instruction or description the packet will carry. */
export const MAX_GAME_UI_INSTRUCTION = 2000;

const ReferenceSnapshotSchema = z.object({ id: z.string().uuid(), content_hash: z.string().min(1) }).strict();

const ScreenContextSchema = z
  .object({
    screen_id: z.string().uuid(),
    draft_revision: z.number().int().min(1),
    spec_snapshot: ScreenSpecV1Schema,
    wireframe_input_id: z.string().uuid().nullable(),
    source_content_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    request_id: z.string().uuid(),
  })
  .strict();

const ElementContextSchema = z
  .object({
    screen_id: z.string().uuid(),
    render_id: z.string().uuid(),
    element_set_id: z.string().uuid(),
    element_id: z.string().uuid(),
    element_snapshot: GameUiElementSchema,
    source_content_hash: z.string().regex(/^[0-9a-f]{64}$/),
    request_id: z.string().uuid(),
  })
  .strict();

const packetBase = {
  packet_version: z.literal(GAME_UI_PACKET_VERSION),
  domain: z.literal("game_ui"),
  style_id: z.string().uuid(),
  style_revision: z.string().uuid(),
  schema_snapshot: GameUiStyleSchemaV1,
  operation: AiOperationSchema,
  original_prompt: z.string().trim().min(1).max(MAX_GAME_UI_INSTRUCTION),
  compiled_prompt: z.string().min(1).max(8000),
  reference_snapshot: z.array(ReferenceSnapshotSchema).min(1),
  source_version_id: z.string().uuid().nullable(),
  model: SupportedModelIdSchema,
  size: SupportedSizeSchema,
  quality: SupportedQualitySchema,
  count: GenerationCountSchema,
  background: z.literal("transparent").nullable().optional(),
  cost_mode: z.enum(["strict_style", "strict_1000", "balanced", "quality"]).optional(),
  metadata: z.object({ library_reference_ids: z.array(z.string().uuid()).optional() }).strict().optional(),
} as const;

// Discriminated on intent: the worker and the plan code must be able to tell a
// screen render from an element reconstruction without inspecting the context.
export const GameUiScreenPacketSchema = z.object({ ...packetBase, intent: z.literal("screen"), context: ScreenContextSchema }).strict();
export const GameUiElementPacketSchema = z
  .object({ ...packetBase, intent: z.literal("element_reconstruction"), context: ElementContextSchema })
  .strict();
export const GameUiGenerationPacketSchema = z.discriminatedUnion("intent", [GameUiScreenPacketSchema, GameUiElementPacketSchema]);

export type GameUiGenerationPacket = z.infer<typeof GameUiGenerationPacketSchema>;
export type GameUiScreenContext = z.infer<typeof ScreenContextSchema>;
export type GameUiElementContext = z.infer<typeof ElementContextSchema>;

export interface CompileGameUiScreenPacketInput {
  intent: "screen";
  styleId: string;
  styleRevision: string;
  schema: GameUiStyleSchema;
  spec: ScreenSpec;
  screenId: string;
  draftRevision: number;
  wireframeInputId: string | null;
  sourceVersionId: string | null;
  sourceContentHash: string | null;
  references: ReadonlyArray<{ id: string; content_hash: string }>;
  libraryReferenceIds?: readonly string[];
  operation: "text_to_image" | "image_to_image";
  model: string;
  size: string;
  quality: string;
  count: number;
  background?: "transparent" | null;
  costMode?: string | null;
  requestId: string;
}

export interface CompileGameUiElementPacketInput {
  intent: "element_reconstruction";
  styleId: string;
  styleRevision: string;
  schema: GameUiStyleSchema;
  instruction: string;
  screenId: string;
  renderId: string;
  elementSetId: string;
  revisionId: string;
  element: ElementDocument["elements"][number];
  sourceVersionId: string;
  sourceContentHash: string;
  references: ReadonlyArray<{ id: string; content_hash: string }>;
  libraryReferenceIds?: readonly string[];
  model: string;
  size: string;
  quality: string;
  costMode?: string | null;
  requestId: string;
}

export type CompileGameUiPacketInput = CompileGameUiScreenPacketInput | CompileGameUiElementPacketInput;

function bullet(label: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `${label}: ${trimmed}` : null;
}

function styleSection(schema: GameUiStyleSchema, kinds: readonly string[]): string[] {
  const lines = [`STYLE (${schema.name})`, schema.visual_language.trim()];
  const palette = schema.palette.map((token) => `${token.role} ${token.color}${token.notes.trim() ? ` (${token.notes.trim()})` : ""}`);
  lines.push(`Palette: ${palette.join("; ")}`);
  const typography = schema.typography.map((rule) =>
    [rule.role, rule.family_description, rule.weight, rule.casing !== "unchanged" ? rule.casing : null, rule.effects]
      .filter((part) => typeof part === "string" && part.trim().length > 0)
      .join(" / "),
  );
  lines.push(`Typography: ${typography.join("; ")}`);
  lines.push(`Layout: ${schema.layout.density}${schema.layout.spacing_rules.trim() ? `, ${schema.layout.spacing_rules.trim()}` : ""}`);
  for (const line of [
    bullet("Alignment", schema.layout.alignment_rules),
    bullet("Safe areas", schema.layout.safe_area_rules),
    bullet("Hierarchy", schema.layout.hierarchy_rules),
    bullet("Shape", schema.shape.corner_rules),
    bullet("Borders", schema.shape.border_rules),
    bullet("Silhouettes", schema.shape.silhouette_rules),
    bullet("Materials", schema.surface.materials),
    bullet("Shading", schema.surface.shading),
    bullet("Shadows", schema.surface.shadows),
    bullet("Highlights", schema.surface.highlights),
    bullet("Icon construction", schema.iconography.construction),
    bullet("Icon strokes", schema.iconography.stroke_rules),
  ]) {
    if (line) lines.push(line);
  }
  // Only the components this screen actually uses: the whole catalogue would
  // bury the requirements under instructions for elements that are not there.
  const wanted = schema.components.filter((component) => kinds.includes(component.kind));
  for (const component of wanted.length > 0 ? wanted : schema.components.slice(0, 8)) {
    const detail = [component.appearance, component.text_rules, component.composition_rules].map((part) => part.trim()).filter(Boolean).join(" | ");
    lines.push(`${component.kind}: ${detail || KIND_DESCRIPTIONS[component.kind]}`);
  }
  if (schema.invariants.length > 0) lines.push(`Must hold: ${schema.invariants.join("; ")}`);
  if (schema.avoid.length > 0) lines.push(`Never: ${schema.avoid.join("; ")}`);
  return lines;
}

function screenSection(spec: ScreenSpec): string[] {
  const lines = [`SCREEN (${spec.name})`, spec.description.trim() || "No description given."];
  if (spec.layout_notes.trim()) lines.push(`Layout notes: ${spec.layout_notes.trim()}`);
  lines.push("Required elements:");
  for (const requirement of spec.requirements) {
    const parts = [
      `- ${requirement.name} [${requirement.kind}${requirement.custom_type ? `: ${requirement.custom_type}` : ""}]`,
      requirement.required ? "required" : "optional",
      requirement.visible_text ? `text "${requirement.visible_text}"` : null,
      requirement.visible_state ? `state: ${requirement.visible_state}` : null,
      requirement.purpose.trim() ? `purpose: ${requirement.purpose.trim()}` : null,
    ];
    lines.push(parts.filter(Boolean).join(" · "));
  }
  lines.push("Draw every required element legibly and in the style above; keep text short, spelled correctly and inside its control.");
  return lines;
}

function elementSection(element: ElementDocument["elements"][number], instruction: string): string[] {
  const bounds = element.bounds;
  return [
    `ELEMENT (${element.name} [${element.kind}${element.custom_type ? `: ${element.custom_type}` : ""}])`,
    element.purpose.trim() ? `Purpose: ${element.purpose.trim()}` : "Purpose: not stated.",
    element.visible_text ? `Visible text: "${element.visible_text}"` : "No text inside the element.",
    element.visible_state ? `Visible state: ${element.visible_state}` : "Visible state: not stated.",
    `Source box: x=${bounds.x} y=${bounds.y} width=${bounds.width} height=${bounds.height} (${element.occluded ? "partly hidden in the source image" : "fully visible in the source image"})`,
    `Instruction: ${instruction}`,
    "Redraw only this element at the same size and proportions, keeping the style above; return it isolated on a fully transparent background with nothing from the surrounding screen.",
  ];
}

function inputRoles(wireframe: boolean, background: boolean): string[] {
  const lines = ["INPUT ROLES"];
  if (wireframe) lines.push("The source image is a wireframe: follow its layout, spacing and element placement, but never copy its placeholder wording, colours or rough shapes.");
  lines.push("The reference images define the visual style only; do not copy their specific text, numbers, logos or characters.");
  if (background) lines.push("Return the image with a transparent background outside the interface artwork.");
  return lines;
}

/**
 * Compile the durable packet.  Pure and provider-independent: the same packet is
 * stored with the job, hashed for consent and re-checked inside the enqueue RPC.
 */
export function compileGameUiPacket(input: CompileGameUiPacketInput): GameUiGenerationPacket {
  const referenceSnapshot = input.references.map((reference) => ({ id: reference.id, content_hash: reference.content_hash }));
  if (referenceSnapshot.length === 0) throw new GameUiError("INVALID_REQUEST", "A confirmed style needs at least one reference image");

  let originalPrompt: string;
  let compiledPrompt: string;
  let operation: "text_to_image" | "image_to_image";
  let sourceVersionId: string | null;
  let background: "transparent" | null;
  let count: number;
  let context: GameUiScreenContext | GameUiElementContext;

  if (input.intent === "screen") {
    const kinds = input.spec.requirements.map((requirement) => requirement.kind);
    originalPrompt = input.spec.description.trim() || input.spec.name;
    operation = input.operation;
    sourceVersionId = input.sourceVersionId;
    background = input.background ?? null;
    count = input.count;
    context = {
      screen_id: input.screenId,
      draft_revision: input.draftRevision,
      spec_snapshot: input.spec,
      wireframe_input_id: input.wireframeInputId,
      source_content_hash: input.sourceContentHash,
      request_id: input.requestId,
    };
    compiledPrompt = [
      ...styleSection(input.schema, kinds),
      "",
      ...screenSection(input.spec),
      ...(input.spec.requirements.some((requirement) => ORGANIZATIONAL_KINDS.includes(requirement.kind))
        ? ["A grouped requirement is a layout grouping, not something to draw."]
        : []),
      "",
      ...inputRoles(input.wireframeInputId !== null, background === "transparent"),
    ].join("\n");
  } else {
    originalPrompt = input.instruction.trim();
    operation = "image_to_image";
    sourceVersionId = input.sourceVersionId;
    background = "transparent";
    count = 1;
    context = {
      screen_id: input.screenId,
      render_id: input.renderId,
      element_set_id: input.elementSetId,
      element_id: input.revisionId,
      element_snapshot: input.element,
      source_content_hash: input.sourceContentHash,
      request_id: input.requestId,
    };
    compiledPrompt = [
      ...styleSection(input.schema, [input.element.kind]),
      "",
      ...elementSection(input.element, input.instruction),
      "",
      ...inputRoles(false, true),
    ].join("\n");
  }

  if (compiledPrompt.length > 8000) {
    throw new GameUiError("PROMPT_TOO_LONG", `The compiled prompt is ${compiledPrompt.length} characters; shorten the description or the requirement list`);
  }

  const packet = {
    packet_version: GAME_UI_PACKET_VERSION as 2,
    domain: "game_ui" as const,
    style_id: input.styleId,
    style_revision: input.styleRevision,
    schema_snapshot: input.schema,
    operation,
    original_prompt: originalPrompt.slice(0, MAX_GAME_UI_INSTRUCTION),
    compiled_prompt: compiledPrompt,
    reference_snapshot: referenceSnapshot,
    source_version_id: sourceVersionId,
    model: input.model,
    size: input.size,
    quality: input.quality,
    count,
    ...(background ? { background } : {}),
    intent: input.intent,
    context,
    ...(input.costMode ? { cost_mode: input.costMode } : {}),
    ...(input.libraryReferenceIds && input.libraryReferenceIds.length > 0
      ? { metadata: { library_reference_ids: [...input.libraryReferenceIds] } }
      : {}),
  };
  const parsed = GameUiGenerationPacketSchema.safeParse(packet);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new GameUiError("INVALID_REQUEST", `Packet ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** Canonical JSON: object keys sorted, arrays in order - a stable consent hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
