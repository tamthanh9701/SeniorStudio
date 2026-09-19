// Screen specification suggestions and element detection.  Both are synchronous
// vision calls: they produce a *proposal* that the user reviews and saves
// explicitly, so neither one is allowed to write to the database.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

import { GameUiError } from "./errors";
import { parseScreenSpec, type ElementDocument, type GameUiElement, type ScreenSpec } from "./contracts";
import { GameUiGenerationPacketSchema } from "./generation-packet";
import { kindCatalogForPrompt, isElementKind, type ElementKind } from "./taxonomy";
import { parseGameUiConfirmedDefinition } from "@/lib/style/confirmed-definition";
import { parseGameUiStyleSchema, type GameUiStyleSchema } from "./style-schema";
import { parseAnalysisJson, requestStyleAnalysis } from "@/lib/style/analysis-runner";
import { preprocessReferences } from "@/lib/style/reference-preprocess";
import { resolveStyleProviderConfig } from "@/lib/style/providers/config";
import { downscaleReferences } from "@/lib/style/analysis-references";
import type { ReferenceInput } from "@/lib/style/reference-preprocess";
import { getOwnedAssetVersion, downloadOwnedBytes } from "@/lib/assets/ownership";
import type { ProviderImage } from "@/lib/ai/providers/types";

/** Detection reads small UI details, so it keeps more resolution than analysis. */
const DETECTION_MAX_EDGE = 1024;

export const SUGGEST_SCREEN_SYSTEM = `You are a game UI designer. Given a description of a game screen and optionally a wireframe image, propose the list of interface elements that screen must contain.

Respond with ONLY a JSON object in exactly this shape, no prose and no markdown fence:
{
  "name": "short screen name",
  "description": "what the screen is for",
  "layout_notes": "how the elements are arranged",
  "requirements": [
    { "kind": "<element kind>", "custom_type": null, "name": "Continue button", "purpose": "confirm the reward", "visible_text": "Continue", "visible_state": null, "required": true }
  ]
}

Element kinds you must use (exact identifiers):
${kindCatalogForPrompt()}

Rules:
- One entry per element the screen needs, at most 40. Do not invent state variants that are not visible on this screen.
- "custom_type" is only for kind "custom", otherwise null.
- When the user's description names a label, keep that exact wording in "visible_text"; otherwise use null rather than inventing text.
- A wireframe shows layout, not final wording or colour: use it for placement and element kinds, never copy its placeholder text.
- "required" is false only for elements that could be omitted without breaking the screen.`;

export const DETECT_ELEMENTS_SYSTEM = `You are a game UI analyst. You are shown one rendered game screen image and the list of elements that screen was supposed to contain. Report where each element actually is in the image.

Respond with ONLY a JSON object in exactly this shape, no prose and no markdown fence:
{
  "elements": [
    { "temp_id": "e1", "parent_temp_id": null, "kind": "<element kind>", "custom_type": null, "name": "Health bar", "purpose": "", "visible_text": null, "visible_state": null,
      "bounds": { "left": 0.05, "top": 0.04, "right": 0.42, "bottom": 0.11 }, "z_index": 0, "occluded": false, "confidence": 0.9, "notes": "" }
  ],
  "coverage": [ { "requirement": "<exact requirement name>", "status": "present|missing|uncertain", "note": "", "elements": ["e1"] } ]
}

Element kinds you must use (exact identifiers):
${kindCatalogForPrompt()}

Rules:
- Coordinates are fractions of the image: 0 is the left/top edge, 1 is the right/bottom edge. Report what is visible, not what should be there.
- Report only elements you can actually see, at most 60. An element that is missing must appear in "coverage" as "missing" instead of being invented here.
- A bar that is drawn as a groove plus a filled portion may be reported as one element, or as the parent plus "bar_track"/"bar_fill" children when both are clearly visible.
- Use "temp_id" strings only; the identifiers are replaced with server ids afterwards.
- Group related parts with "parent_temp_id" only when the child is visibly inside the parent's rectangle.
- "confidence" is your own 0..1 estimate that the box is correct; omit it (null) when you are reporting something certain.`;

async function loadStyleSchema(definition: unknown): Promise<GameUiStyleSchema> {
  let parsedDefinition;
  try {
    parsedDefinition = parseGameUiConfirmedDefinition(definition ?? null);
  } catch {
    throw new GameUiError("STYLE_DEFINITION_INVALID", "The confirmed definition is not a Game UI definition");
  }
  if (!parsedDefinition) throw new GameUiError("STYLE_NOT_READY", "Confirm the style before using it");
  try {
    return parseGameUiStyleSchema(parsedDefinition.schema_snapshot);
  } catch (error) {
    throw new GameUiError("STYLE_DEFINITION_INVALID", `The confirmed schema is invalid: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

/** Download one style-owned image version through the ownership boundary. */
async function loadOwnedImage(service: SupabaseClient, workspaceId: string, assetId: string, versionId: string): Promise<ReferenceInput> {
  const owned = await getOwnedAssetVersion(service, workspaceId, assetId, versionId);
  const downloaded = await downloadOwnedBytes(service, owned.owned);
  return { id: versionId, buffer: Buffer.from(downloaded.bytes), mimeType: downloaded.mimeType };
}

function requirementPromptLines(spec: ScreenSpec): string[] {
  return spec.requirements.map(
    (requirement) =>
      `- ${requirement.name} [${requirement.kind}${requirement.custom_type ? `: ${requirement.custom_type}` : ""}]${requirement.visible_text ? ` text "${requirement.visible_text}"` : ""}${requirement.required ? " (required)" : ""}`,
  );
}

/** Propose the element list for a screen draft. Nothing is saved. */
export async function suggestGameUiScreenSpec(
  client: SupabaseClient,
  service: SupabaseClient,
  request: { screenId: string; expectedRevision: number },
): Promise<{ spec: ScreenSpec; expectedRevision: number; warnings: string[] }> {
  const { data: screen, error } = await client
    .from("game_ui_screens")
    .select("id, workspace_id, style_id, name, draft_spec, draft_revision, wireframe_version_id")
    .eq("id", request.screenId)
    .maybeSingle();
  if (error || !screen) throw new GameUiError("SCREEN_NOT_FOUND", "Screen not found");
  const row = screen as {
    id: string;
    workspace_id: string;
    style_id: string;
    name: string;
    draft_revision: number;
    draft_spec: ScreenSpec;
    wireframe_version_id: string | null;
  };
  if (row.draft_revision !== request.expectedRevision) {
    throw new GameUiError("SCREEN_VERSION_CONFLICT", "This screen changed since it was loaded; reload it");
  }
  const { data: style, error: styleError } = await client
    .from("styles")
    .select("id, workspace_id, status, schema, confirmed_definition")
    .eq("id", row.style_id)
    .maybeSingle();
  if (styleError || !style) throw new GameUiError("STYLE_NOT_FOUND", "Style not found");
  const schema = await loadStyleSchema((style as { confirmed_definition: unknown }).confirmed_definition);

  const images: ReferenceInput[] = [];
  if (row.wireframe_version_id) {
    const { data: input } = await client
      .from("game_ui_inputs")
      .select("version_id")
      .eq("version_id", row.wireframe_version_id)
      .eq("kind", "wireframe")
      .maybeSingle();
    if (!input) throw new GameUiError("INPUT_NOT_FOUND", "The attached wireframe is no longer available");
    const { data: version } = await service
      .from("asset_versions")
      .select("id, asset_id")
      .eq("id", row.wireframe_version_id)
      .maybeSingle();
    if (!version) throw new GameUiError("INPUT_NOT_FOUND", "The attached wireframe is no longer available");
    images.push(await loadOwnedImage(service, row.workspace_id, (version as { asset_id: string }).asset_id, row.wireframe_version_id));
  }
  const bounded = images.length > 0 ? await downscaleReferences(images, DETECTION_MAX_EDGE) : [];
  // Measured on the originals, like every other analysis call in this codebase.
  const summary = await preprocessReferences(images);

  const config = await resolveStyleProviderConfig({ service, workspaceId: row.workspace_id });
  const rawText = await requestStyleAnalysis({
    config,
    references: bounded,
    summary,
    systemPrompt: SUGGEST_SCREEN_SYSTEM,
    userMessage: [
      `Screen: ${row.name}`,
      `Description: ${row.draft_spec?.description?.trim() || "not written yet"}`,
      row.draft_spec?.layout_notes?.trim() ? `Layout notes: ${row.draft_spec.layout_notes.trim()}` : "No layout notes.",
      `UI style: ${schema.name} - ${schema.visual_language}`,
      `Style components: ${schema.components.map((component) => component.kind).join(", ")}`,
      images.length > 0 ? "A wireframe image is attached: follow its layout." : "No wireframe is attached.",
      "Propose the required elements as the JSON object defined in the system message.",
    ].join("\n"),
  });

  const candidate = parseAnalysisJson(rawText, "GAME_UI_ANALYSIS_INVALID", "The suggestion was not valid JSON");
  const warnings: string[] = [];
  const record = (candidate ?? {}) as Record<string, unknown>;
  const rawRequirements = Array.isArray(record.requirements) ? record.requirements : [];
  const requirements = rawRequirements.slice(0, 40).map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const kind = isElementKind(item.kind) ? item.kind : "custom";
    if (!isElementKind(item.kind)) warnings.push(`Unknown element kind "${String(item.kind)}" was recorded as a custom element.`);
    return {
      id: randomUUID(),
      kind,
      custom_type: kind === "custom" ? String(item.custom_type ?? item.name ?? "custom element").slice(0, 100) : null,
      name: String(item.name ?? "Element").slice(0, 100) || "Element",
      purpose: String(item.purpose ?? "").slice(0, 1000),
      visible_text: item.visible_text == null ? null : String(item.visible_text).slice(0, 500),
      visible_state: item.visible_state == null ? null : String(item.visible_state).slice(0, 200),
      required: item.required === false ? false : true,
    };
  });
  if (rawRequirements.length > 40) warnings.push(`${rawRequirements.length - 40} more proposed element(s) were dropped: the limit is 40 per screen.`);

  const spec = parseScreenSpec({
    schema_version: 1,
    name: String(record.name ?? row.name).slice(0, 100) || row.name,
    description: String(record.description ?? "").slice(0, 2000),
    layout_notes: String(record.layout_notes ?? "").slice(0, 2000),
    requirements,
  });
  return { spec, expectedRevision: row.draft_revision, warnings };
}

/**
 * Convert normalized boxes to source pixels.  A box that starts inside the image
 * but crosses an edge is clamped (a model that is a pixel out is not worth another
 * paid call); a box that is essentially outside, inverted or empty is dropped and
 * reported instead of being reshaped into something the user did not ask for.
 */
function boundsFromNormalized(
  bounds: { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown },
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const numbers = [bounds.left, bounds.top, bounds.right, bounds.bottom].map((value) => Number(value));
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const [left, top, right, bottom] = numbers;
  const x = Math.max(0, Math.min(width - 1, Math.floor(left * width)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(top * height)));
  const x2 = Math.max(0, Math.min(width, Math.ceil(right * width)));
  const y2 = Math.max(0, Math.min(height, Math.ceil(bottom * height)));
  const boxWidth = x2 - x;
  const boxHeight = y2 - y;
  // A box that barely overlaps the image, or is inverted/empty once rounded, is
  // not an element; reporting it as one would put a wrong crop in front of the user.
  if (boxWidth < 2 || boxHeight < 2) return null;
  if (left > 1.02 || top > 1.02 || right < -0.02 || bottom < -0.02) return null;
  return { x, y, width: boxWidth, height: boxHeight };
}

function contains(outer: GameUiElement["bounds"], inner: GameUiElement["bounds"]): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/** Detect the elements of one generated screen. Nothing is saved. */
export async function detectGameUiElements(
  client: SupabaseClient,
  service: SupabaseClient,
  request: { renderId: string },
): Promise<{ document: ElementDocument; expectedRevision: number; warnings: string[] }> {
  const { data: render, error } = await client
    .from("game_ui_renders")
    .select("id, workspace_id, style_id, screen_id, asset_id, version_id, spec_snapshot")
    .eq("id", request.renderId)
    .maybeSingle();
  if (error || !render) throw new GameUiError("RENDER_NOT_FOUND", "Generated screen not found");
  const row = render as { id: string; workspace_id: string; style_id: string; screen_id: string; asset_id: string; version_id: string; spec_snapshot: ScreenSpec };
  const spec = parseScreenSpec(row.spec_snapshot);

  const { data: version } = await client
    .from("asset_versions")
    .select("id, asset_id, width, height, style_generation")
    .eq("id", row.version_id)
    .eq("asset_id", row.asset_id)
    .maybeSingle();
  if (!version) throw new GameUiError("RENDER_NOT_FOUND", "The generated screen version no longer exists");
  const width = (version as { width: number }).width;
  const height = (version as { height: number }).height;
  const packet = GameUiGenerationPacketSchema.safeParse((version as { style_generation: unknown }).style_generation);
  let schema: GameUiStyleSchema;
  if (packet.success) {
    schema = packet.data.schema_snapshot;
  } else {
    const { data: style } = await client.from("styles").select("confirmed_definition").eq("id", row.style_id).maybeSingle();
    schema = await loadStyleSchema((style as { confirmed_definition: unknown } | null)?.confirmed_definition ?? null);
  }

  const { data: latestSet } = await client
    .from("game_ui_element_sets")
    .select("id, revision")
    .eq("render_id", row.id)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  const expectedRevision = (latestSet as { revision: number } | null)?.revision ?? 0;

  const image = await loadOwnedImage(service, row.workspace_id, row.asset_id, row.version_id);
  const [bounded] = await downscaleReferences([image], DETECTION_MAX_EDGE);
  const summary = await preprocessReferences([image]);
  const config = await resolveStyleProviderConfig({ service, workspaceId: row.workspace_id });
  const rawText = await requestStyleAnalysis({
    config,
    references: [bounded],
    summary,
    systemPrompt: DETECT_ELEMENTS_SYSTEM,
    userMessage: [
      `Screen: ${spec.name}`,
      `UI style: ${schema.name} - ${schema.visual_language}`,
      "Elements this screen was supposed to contain:",
      ...requirementPromptLines(spec),
      "Report the visible elements as the JSON object defined in the system message.",
    ].join("\n"),
  });

  const candidate = parseAnalysisJson(rawText, "GAME_UI_ANALYSIS_INVALID", "The detection was not valid JSON");
  const warnings: string[] = [];
  const record = (candidate ?? {}) as Record<string, unknown>;
  const rawElements = Array.isArray(record.elements) ? record.elements : [];
  if (rawElements.length > 100) warnings.push(`${rawElements.length - 100} proposed element(s) were dropped: the limit is 100 per image.`);

  const byTempId = new Map<string, GameUiElement>();
  const elements: GameUiElement[] = [];
  for (const entry of rawElements.slice(0, 100)) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const tempId = typeof item.temp_id === "string" && item.temp_id.length > 0 ? item.temp_id : `auto-${elements.length + 1}`;
    const rawBounds = (item.bounds ?? {}) as { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown };
    const bounds = boundsFromNormalized(rawBounds, width, height);
    if (!bounds) {
      warnings.push(`"${String(item.name ?? tempId)}" was dropped: its box is outside the ${width}×${height} image or too small.`);
      continue;
    }
    const kind: ElementKind = isElementKind(item.kind) ? item.kind : "custom";
    if (!isElementKind(item.kind)) warnings.push(`Unknown element kind "${String(item.kind)}" was recorded as a custom element.`);
    const element: GameUiElement = {
      id: randomUUID(),
      parent_id: null,
      kind,
      custom_type: kind === "custom" ? String(item.custom_type ?? item.name ?? "custom element").slice(0, 100) : null,
      name: (String(item.name ?? "Element").slice(0, 100) || "Element"),
      purpose: String(item.purpose ?? "").slice(0, 1000),
      visible_text: item.visible_text == null ? null : String(item.visible_text).slice(0, 500),
      visible_state: item.visible_state == null ? null : String(item.visible_state).slice(0, 200),
      bounds,
      z_index: Number.isInteger(item.z_index) ? (item.z_index as number) : elements.length,
      occluded: item.occluded === true,
      confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null,
      notes: String(item.notes ?? "").slice(0, 1000),
      reviewed: false,
    };
    const parentTempId = typeof item.parent_temp_id === "string" ? item.parent_temp_id : null;
    if (parentTempId) {
      const parent = byTempId.get(parentTempId);
      // A parent link the model got wrong is detached, not guessed: the element
      // stays, and the user can attach it after seeing both boxes.
      if (!parent) warnings.push(`"${element.name}" kept as a top-level element: its proposed parent is unknown.`);
      else if (!contains(parent.bounds, element.bounds)) warnings.push(`"${element.name}" kept as a top-level element: the proposed parent does not contain it.`);
      else if (parent.parent_id === element.id) warnings.push(`"${element.name}" kept as a top-level element: the proposed parent chain loops.`);
      else element.parent_id = parent.id;
    }
    byTempId.set(tempId, element);
    elements.push(element);
  }

  const requirementByName = new Map(spec.requirements.map((requirement) => [requirement.name.trim().toLowerCase(), requirement.id]));
  const rawCoverage = Array.isArray(record.coverage) ? record.coverage : [];
  const coverage: ElementDocument["coverage"] = [];
  for (const entry of rawCoverage.slice(0, 100)) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const requirementId = requirementByName.get(String(item.requirement ?? "").trim().toLowerCase());
    if (!requirementId) continue; // A verdict about a requirement the screen does not list.
    const status = item.status === "present" || item.status === "uncertain" ? item.status : "missing";
    const tempIds = Array.isArray(item.elements) ? item.elements.map((value) => String(value)) : [];
    coverage.push({
      requirement_id: requirementId,
      element_ids: tempIds.map((tempId) => byTempId.get(tempId)?.id).filter((id): id is string => Boolean(id)),
      status,
      note: String(item.note ?? "").slice(0, 500),
    });
  }
  for (const requirement of spec.requirements) {
    if (!coverage.some((entry) => entry.requirement_id === requirement.id)) {
      coverage.push({ requirement_id: requirement.id, element_ids: [], status: "uncertain", note: "The analysis did not report this element." });
    }
  }

  const document: ElementDocument = {
    schema_version: 1,
    render_id: row.id,
    source_version_id: row.version_id,
    canvas: { width, height },
    elements,
    coverage,
  };
  if (elements.length === 0) warnings.push("No element could be located in this image; add them by hand or run the detection again.");
  return { document, expectedRevision, warnings };
}
