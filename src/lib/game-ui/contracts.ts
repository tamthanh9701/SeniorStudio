// Screen requirements and per-image element maps.  A requirement list is what
// the screen must contain; an element document is what one generated image
// actually shows, with source-pixel geometry, so an export always names the
// exact pixels it came from.
import { z } from "zod";

import { GameUiError } from "./errors";
import { ELEMENT_KINDS } from "./taxonomy";

export const MAX_ELEMENTS_PER_SCREEN = 100;
export const MAX_REQUIREMENTS_PER_SCREEN = 100;
/** Serialized document ceiling; a bigger map is a bug or an attack, not a screen. */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

const nullableShortText = z.string().trim().max(500).nullable();
const nullableState = z.string().trim().max(200).nullable();

const CustomTypeSchema = z
  .object({
    kind: z.enum(ELEMENT_KINDS),
    custom_type: z.string().trim().max(100).nullable(),
  })
  .strict();

/** `custom` must name itself; every other kind must leave custom_type null. */
function customTypeProblem(label: string, value: z.infer<typeof CustomTypeSchema>): string | null {
  if (value.kind === "custom") {
    return value.custom_type ? null : `${label}: a custom element needs custom_type`;
  }
  return value.custom_type === null ? null : `${label}: custom_type is only allowed for kind "custom"`;
}

export const ScreenRequirementSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(ELEMENT_KINDS),
    custom_type: z.string().trim().max(100).nullable(),
    name: z.string().trim().min(1).max(100),
    purpose: z.string().trim().max(1000),
    visible_text: nullableShortText,
    visible_state: nullableState,
    required: z.boolean().default(true),
  })
  .strict();

export const ScreenSpecV1Schema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000),
    layout_notes: z.string().trim().max(2000),
    requirements: z.array(ScreenRequirementSchema).max(MAX_REQUIREMENTS_PER_SCREEN),
  })
  .strict();

export type ScreenRequirement = z.infer<typeof ScreenRequirementSchema>;
export type ScreenSpec = z.infer<typeof ScreenSpecV1Schema>;

export const ElementBoundsSchema = z
  .object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) })
  .strict();

export const GameUiElementSchema = z
  .object({
    id: z.string().uuid(),
    parent_id: z.string().uuid().nullable(),
    kind: z.enum(ELEMENT_KINDS),
    custom_type: z.string().trim().max(100).nullable(),
    name: z.string().trim().min(1).max(100),
    purpose: z.string().trim().max(1000),
    visible_text: nullableShortText,
    visible_state: nullableState,
    bounds: ElementBoundsSchema,
    z_index: z.number().int(),
    occluded: z.boolean(),
    confidence: z.number().min(0).max(1).nullable(),
    notes: z.string().trim().max(1000),
    reviewed: z.boolean(),
  })
  .strict();

export const CoverageEntrySchema = z
  .object({
    requirement_id: z.string().uuid(),
    element_ids: z.array(z.string().uuid()).max(MAX_ELEMENTS_PER_SCREEN),
    status: z.enum(["present", "missing", "uncertain"]),
    note: z.string().trim().max(500),
  })
  .strict();

export const ElementDocumentV1Schema = z
  .object({
    schema_version: z.literal(1),
    render_id: z.string().uuid(),
    source_version_id: z.string().uuid(),
    canvas: z.object({ width: z.number().int().min(1), height: z.number().int().min(1) }).strict(),
    elements: z.array(GameUiElementSchema).max(MAX_ELEMENTS_PER_SCREEN),
    coverage: z.array(CoverageEntrySchema).max(MAX_REQUIREMENTS_PER_SCREEN),
  })
  .strict();

export type ElementBounds = z.infer<typeof ElementBoundsSchema>;
export type GameUiElement = z.infer<typeof GameUiElementSchema>;
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;
export type ElementDocument = z.infer<typeof ElementDocumentV1Schema>;
export type GameUiElementInput = z.input<typeof GameUiElementSchema>;

/** Inclusive containment: a child may touch its parent's edges exactly. */
export function boundsContain(parent: ElementBounds, child: ElementBounds): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height
  );
}

/**
 * Every structural rule the database validator also enforces, reported as a
 * list so the editor can show all problems at once instead of one per attempt.
 */
export function elementGraphProblems(document: ElementDocument): string[] {
  const problems: string[] = [];
  const byId = new Map<string, GameUiElement>();
  for (const element of document.elements) {
    if (byId.has(element.id)) problems.push(`Two elements share the id ${element.id}`);
    byId.set(element.id, element);
  }
  for (const element of document.elements) {
    const label = `${element.name} (${element.kind})`;
    const customProblem = customTypeProblem(label, element);
    if (customProblem) problems.push(customProblem);
    const { x, y, width, height } = element.bounds;
    if (x < 0 || y < 0 || x + width > document.canvas.width || y + height > document.canvas.height) {
      problems.push(`${label}: bounds fall outside the ${document.canvas.width}×${document.canvas.height} image`);
    }
    if (!element.parent_id) continue;
    const parent = byId.get(element.parent_id);
    if (!parent) {
      problems.push(`${label}: parent ${element.parent_id} is not in this document`);
      continue;
    }
    if (!boundsContain(parent.bounds, element.bounds)) {
      problems.push(`${label}: parent ${parent.name} does not contain it`);
    }
    // Walking up from every element finds a cycle even when the cycle is closed
    // by two nodes; the bound stops the walk on a document-wide chain.
    let cursor: GameUiElement | undefined = parent;
    for (let step = 0; cursor && step <= document.elements.length; step += 1) {
      if (cursor.id === element.id) {
        problems.push(`${label}: its parent chain loops back to itself`);
        cursor = undefined;
        break;
      }
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    }
  }
  const seenRequirements = new Set<string>();
  for (const entry of document.coverage) {
    if (seenRequirements.has(entry.requirement_id)) problems.push(`Coverage repeats requirement ${entry.requirement_id}`);
    seenRequirements.add(entry.requirement_id);
    for (const elementId of entry.element_ids) {
      if (!byId.has(elementId)) problems.push(`Coverage points at ${elementId}, which is not in this document`);
    }
  }
  return problems;
}

function assertWithinBytes(label: string, value: unknown) {
  // TextEncoder rather than Buffer: this module is also bundled for the browser,
  // where Buffer is not defined.
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new GameUiError("DOCUMENT_TOO_LARGE", `${label} is ${bytes} bytes; the limit is ${MAX_DOCUMENT_BYTES}`);
  }
}

function invalid(message: string, path: string, detail: string): GameUiError {
  return new GameUiError("INVALID_REQUEST", `${message} at ${path}: ${detail}`);
}

export function parseScreenSpec(value: unknown): ScreenSpec {
  const parsed = ScreenSpecV1Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid("Invalid screen specification", issue?.path.join(".") || "spec", issue?.message ?? "unknown");
  }
  const spec = parsed.data;
  const seen = new Set<string>();
  for (const requirement of spec.requirements) {
    if (seen.has(requirement.id)) throw new GameUiError("INVALID_REQUEST", `Two requirements share the id ${requirement.id}`);
    seen.add(requirement.id);
    const problem = customTypeProblem(`${requirement.name} (${requirement.kind})`, requirement);
    if (problem) throw new GameUiError("INVALID_REQUEST", problem);
  }
  assertWithinBytes("Screen specification", spec);
  return spec;
}

/**
 * Parse one element map.  When the decoded image dimensions are known they are
 * compared with the recorded canvas: a map drawn against a stale image would
 * otherwise crop the wrong pixels forever.
 */
export function parseElementDocument(
  value: unknown,
  sourceDimensions?: { width: number; height: number },
): ElementDocument {
  const parsed = ElementDocumentV1Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid("Invalid element document", issue?.path.join(".") || "document", issue?.message ?? "unknown");
  }
  const document = parsed.data;
  if (sourceDimensions && (document.canvas.width !== sourceDimensions.width || document.canvas.height !== sourceDimensions.height)) {
    throw new GameUiError(
      "INVALID_REQUEST",
      `Element document canvas ${document.canvas.width}×${document.canvas.height} does not match the image ${sourceDimensions.width}×${sourceDimensions.height}`,
    );
  }
  const problems = elementGraphProblems(document);
  if (problems.length > 0) throw new GameUiError("INVALID_REQUEST", problems[0]);
  assertWithinBytes("Element document", document);
  return document;
}
