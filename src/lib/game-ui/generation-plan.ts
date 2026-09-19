// Planning a Game UI generation: read the server-side authority (the confirmed
// Game UI definition for a screen, the render's own packet for a reconstruction),
// bound the reference set to what the chosen model accepts, compile the version 2
// packet and hash it so the browser can consent to exactly this plan.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { GameUiError } from "./errors";
import { canonicalJson, compileGameUiPacket, GameUiGenerationPacketSchema, type GameUiGenerationPacket } from "./generation-packet";
import { parseGameUiStyleSchema, type GameUiStyleSchema } from "./style-schema";
import { parseElementDocument, parseScreenSpec, type ElementDocument, type GameUiElement, type ScreenSpec } from "./contracts";
import { parseGameUiConfirmedDefinition, type ConfirmedGameUiDefinition } from "@/lib/style/confirmed-definition";
import { getModelCatalog } from "@/lib/ai/models";
import { resolveImageExecutionPlan, type ExecutionPlan } from "@/lib/ai/execution-plan";

type OrderedReference = { id: string; content_hash: string; borrowed: boolean };

export interface GameUiGenerationPlanView {
  intent: "screen" | "element_reconstruction";
  operation: "text_to_image" | "image_to_image";
  requestedModelId: string;
  effectiveModelId: string;
  provider: string;
  size: string;
  quality: string;
  count: number;
  referenceIds: string[];
  omittedReferenceIds: string[];
  sourceVersionId: string | null;
  modelChanged: boolean;
  explanation: string;
  supported: true;
  compiledPrompt: string;
  planHash: string;
}

export interface GameUiPlanResult {
  plan: GameUiGenerationPlanView;
  packet: GameUiGenerationPacket;
  planHash: string;
}

interface StyleRow {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  domain: string;
  schema: unknown;
  confirmed_definition: unknown;
  library_id: string | null;
}

interface ScreenRow {
  id: string;
  workspace_id: string;
  style_id: string;
  name: string;
  draft_spec: unknown;
  draft_revision: number;
  wireframe_version_id: string | null;
}

interface RenderRow {
  id: string;
  workspace_id: string;
  style_id: string;
  screen_id: string;
  asset_id: string;
  version_id: string;
  spec_snapshot: unknown;
  style_revision: string;
}

/** The packet hash the browser consents to; the caller's request id is the one key that may differ between preview and generate. */
export function hashGameUiPlan(packet: GameUiGenerationPacket): string {
  const { context, ...rest } = packet;
  const { request_id: _requestId, ...comparableContext } = context as Record<string, unknown> & { request_id?: string };
  return createHash("sha256").update(canonicalJson({ ...rest, context: comparableContext })).digest("hex");
}

async function loadStyle(client: SupabaseClient, styleId: string): Promise<StyleRow> {
  const { data, error } = await client
    .from("styles")
    .select("id, workspace_id, name, status, domain, schema, confirmed_definition, library_id")
    .eq("id", styleId)
    .maybeSingle();
  if (error || !data) throw new GameUiError("NOT_FOUND", "Style not found");
  if (data.domain !== "game_ui") throw new GameUiError("INVALID_REQUEST", "This is a visual style; use the Style module");
  return data as StyleRow;
}

/** The confirmed definition is the only authority for a new screen. */
function requireConfirmedDefinition(style: StyleRow): { definition: ConfirmedGameUiDefinition; schema: GameUiStyleSchema; revision: string } {
  if (style.status !== "active") throw new GameUiError("STYLE_NOT_READY", "Confirm the style before generating from it");
  let definition: ConfirmedGameUiDefinition | null;
  try {
    definition = parseGameUiConfirmedDefinition(style.confirmed_definition ?? null);
  } catch {
    throw new GameUiError("STYLE_DEFINITION_INVALID", "The confirmed definition is not a Game UI definition");
  }
  if (!definition) throw new GameUiError("STYLE_NOT_READY", "Confirm the style before generating from it");
  let schema: GameUiStyleSchema;
  try {
    schema = parseGameUiStyleSchema(definition.schema_snapshot);
  } catch (error) {
    throw new GameUiError("STYLE_DEFINITION_INVALID", `The confirmed schema is invalid: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return { definition, schema, revision: definition.style_revision };
}

/**
 * References the plan may send: the style's own live rows plus borrowed rows from
 * the same library, same workspace and same domain.  Order is the caller's, so the
 * packet records the order the user saw.
 */
async function resolveRequestedReferences(
  client: SupabaseClient,
  style: StyleRow,
  requestedIds: readonly string[],
): Promise<OrderedReference[]> {
  if (requestedIds.length === 0) throw new GameUiError("INVALID_REQUEST", "Select at least one style reference image");
  const unique = new Set(requestedIds);
  if (unique.size !== requestedIds.length) throw new GameUiError("INVALID_REQUEST", "A reference was selected twice");
  const { data: rows, error } = await client
    .from("style_references")
    .select("id, content_hash, style_id, styles!inner(id, workspace_id, library_id, domain)")
    .in("id", [...unique])
    .is("retired_at", null);
  if (error) throw new GameUiError("REFERENCE_NOT_FOUND", "Could not verify the selected reference images");
  const owned = new Map<string, OrderedReference>();
  for (const row of rows ?? []) {
    const style0 = (row as unknown as { styles: { id: string; workspace_id: string; library_id: string | null; domain: string } }).styles;
    const contentHash = (row as { content_hash: string | null }).content_hash;
    if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(contentHash)) {
      throw new GameUiError("INVALID_REQUEST", "A selected reference image is missing its content hash");
    }
    const own = style0.id === style.id;
    const borrowed = style0.workspace_id === style.workspace_id && style0.domain === "game_ui" && style.library_id !== null && style0.library_id === style.library_id;
    if (!own && !borrowed) throw new GameUiError("REFERENCE_NOT_FOUND", "A selected reference image is not part of this style or its library");
    const id = (row as { id: string }).id;
    owned.set(id, { id, content_hash: contentHash, borrowed: !own });
  }
  const missing = requestedIds.filter((id) => !owned.has(id));
  if (missing.length > 0) throw new GameUiError("REFERENCE_NOT_FOUND", `${missing.length} selected reference image(s) are no longer available`);
  return requestedIds.map((id) => owned.get(id)!);
}

/**
 * A model accepts a fixed number of input images, and the wireframe (or the screen
 * being reconstructed) takes one of them.  The tail of the selection is dropped -
 * the user sees exactly which references were dropped before consenting - but a
 * model that cannot take the layout input plus at least one style reference is
 * refused rather than quietly generating without the wireframe.
 */
function limitReferencesToModel(
  references: readonly OrderedReference[],
  maxInputImages: number,
  consumesSourceSlot: boolean,
): { included: OrderedReference[]; omitted: OrderedReference[] } {
  const capacity = maxInputImages - (consumesSourceSlot ? 1 : 0);
  if (capacity < 1) {
    throw new GameUiError("UNSUPPORTED_SETTINGS", "This model cannot take the wireframe and a style reference together; choose another model");
  }
  return { included: references.slice(0, capacity), omitted: references.slice(capacity) };
}

/** Plan a screen render: text-to-image, or image-to-image when a wireframe is attached. */
export async function resolveGameUiScreenPlan(
  client: SupabaseClient,
  service: SupabaseClient,
  request: {
    screenId: string;
    expectedRevision: number;
    model: string;
    size: string;
    quality: string;
    count: number;
    referenceIds: string[];
    costMode: string;
    requestId: string;
  },
): Promise<GameUiPlanResult> {
  const { data: screen, error: screenError } = await client
    .from("game_ui_screens")
    .select("id, workspace_id, style_id, name, draft_spec, draft_revision, wireframe_version_id")
    .eq("id", request.screenId)
    .maybeSingle();
  if (screenError || !screen) throw new GameUiError("SCREEN_NOT_FOUND", "Screen not found");
  const screenRow = screen as ScreenRow;
  if (screenRow.draft_revision !== request.expectedRevision) {
    throw new GameUiError("SCREEN_VERSION_CONFLICT", "This screen changed since the plan was requested; reload it");
  }
  const spec: ScreenSpec = parseScreenSpec(screenRow.draft_spec);
  const style = await loadStyle(client, screenRow.style_id);
  const { schema, revision } = requireConfirmedDefinition(style);

  // A wireframe is a registered input of this style; its version is the job source.
  let wireframeInputId: string | null = null;
  let wireframeVersionId: string | null = null;
  let wireframeHash: string | null = null;
  if (screenRow.wireframe_version_id) {
    const { data: input } = await client
      .from("game_ui_inputs")
      .select("id, version_id, content_hash")
      .eq("version_id", screenRow.wireframe_version_id)
      .eq("kind", "wireframe")
      .eq("style_id", style.id)
      .maybeSingle();
    if (!input) throw new GameUiError("INPUT_NOT_FOUND", "The attached wireframe is no longer available");
    wireframeInputId = (input as { id: string }).id;
    wireframeVersionId = (input as { version_id: string }).version_id;
    wireframeHash = (input as { content_hash: string }).content_hash;
  }

  const requested = await resolveRequestedReferences(client, style, request.referenceIds);
  const operation = wireframeVersionId ? "image_to_image" : "text_to_image";
  // Capacity comes from the model the user chose: with preserveRequestedModel the
  // effective model is that model, so the bound is known before the plan call.
  const workspaceId = (style as { workspace_id: string }).workspace_id;
  const catalog = await getModelCatalog(service, workspaceId);
  const entry = catalog.find((candidate) => candidate.id === request.model);
  if (!entry) throw new GameUiError("INVALID_MODEL", "This model is not available in this workspace");
  const { included, omitted } = limitReferencesToModel(requested, entry.maxInputImages ?? 4, wireframeVersionId !== null);
  const execution = await resolveImageExecutionPlan(
    client,
    {
      operation,
      requestedModelId: request.model,
      styleId: style.id,
      sourceVersionId: wireframeVersionId ?? undefined,
      prompt: spec.description || spec.name,
      referenceIds: included.map((reference) => reference.id),
      costMode: request.costMode as never,
      count: request.count,
      size: request.size,
      quality: request.quality,
      background: null,
      preserveRequestedModel: true,
    },
    service,
  );
  const packet = compileGameUiPacket({
    intent: "screen",
    styleId: style.id,
    styleRevision: revision,
    schema,
    spec,
    screenId: screenRow.id,
    draftRevision: screenRow.draft_revision,
    wireframeInputId,
    sourceVersionId: wireframeVersionId,
    sourceContentHash: wireframeHash,
    references: included,
    libraryReferenceIds: included.filter((reference) => reference.borrowed).map((reference) => reference.id),
    operation,
    model: execution.effectiveModelId,
    size: request.size,
    quality: request.quality,
    count: request.count,
    background: null,
    costMode: request.costMode,
    requestId: request.requestId,
  });
  const planHash = hashGameUiPlan(packet);
  return {
    packet,
    planHash,
    plan: {
      intent: "screen",
      operation,
      requestedModelId: execution.requestedModelId,
      effectiveModelId: execution.effectiveModelId,
      provider: execution.provider,
      size: request.size,
      quality: request.quality,
      count: request.count,
      referenceIds: included.map((reference) => reference.id),
      omittedReferenceIds: omitted.map((reference) => reference.id),
      sourceVersionId: wireframeVersionId,
      modelChanged: execution.modelChanged,
      explanation: execution.explanation,
      supported: true,
      compiledPrompt: packet.compiled_prompt,
      planHash,
    },
  };
}

/** Plan an element reconstruction from one saved element map revision. */
export async function resolveGameUiReconstructionPlan(
  client: SupabaseClient,
  service: SupabaseClient,
  request: {
    renderId: string;
    elementSetId: string;
    elementId: string;
    instruction: string;
    model: string;
    size: string;
    quality: string;
    costMode: string;
    requestId: string;
  },
): Promise<GameUiPlanResult> {
  const { data: render, error: renderError } = await client
    .from("game_ui_renders")
    .select("id, workspace_id, style_id, screen_id, asset_id, version_id, spec_snapshot, style_revision")
    .eq("id", request.renderId)
    .maybeSingle();
  if (renderError || !render) throw new GameUiError("RENDER_NOT_FOUND", "Generated screen not found");
  const renderRow = render as RenderRow;

  const { data: set, error: setError } = await client
    .from("game_ui_element_sets")
    .select("id, render_id, revision, document")
    .eq("id", request.elementSetId)
    .eq("render_id", renderRow.id)
    .maybeSingle();
  if (setError || !set) throw new GameUiError("RENDER_NOT_FOUND", "Element map revision not found");
  const { data: latest } = await client
    .from("game_ui_element_sets")
    .select("id, revision")
    .eq("render_id", renderRow.id)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest || (latest as { id: string }).id !== request.elementSetId) {
    throw new GameUiError("SCREEN_VERSION_CONFLICT", "This map has a newer revision; use the newest one");
  }
  const version = { id: renderRow.version_id };
  const document: ElementDocument = parseElementDocument((set as { document: unknown }).document);
  const element = document.elements.find((entry: GameUiElement) => entry.id === request.elementId);
  if (!element) throw new GameUiError("ELEMENT_NOT_FOUND", "The element is not in this map revision");
  if (element.kind === "group") throw new GameUiError("INVALID_REQUEST", "A group has no pixels of its own to reconstruct");

  const style = await loadStyle(client, renderRow.style_id);
  // Authority for a reconstruction is the render's own packet, not the current
  // style: the element belongs to the image the user is looking at.
  const { data: renderVersion } = await client
    .from("asset_versions")
    .select("id, style_generation, metadata")
    .eq("id", version.id)
    .eq("asset_id", renderRow.asset_id)
    .maybeSingle();
  if (!renderVersion) throw new GameUiError("RENDER_NOT_FOUND", "The generated screen version no longer exists");
  const renderPacket = GameUiGenerationPacketSchema.safeParse((renderVersion as { style_generation: unknown }).style_generation);
  if (!renderPacket.success || renderPacket.data.intent !== "screen") {
    throw new GameUiError("STYLE_NOT_READY", "This screen has no recorded Game UI generation to work from");
  }
  const sourceContentHash = (renderVersion as { metadata: Record<string, unknown> }).metadata?.content_hash;
  if (typeof sourceContentHash !== "string" || !/^[0-9a-f]{64}$/i.test(sourceContentHash)) {
    throw new GameUiError("INVALID_REQUEST", "The generated screen has no recorded content hash");
  }

  const catalog = await getModelCatalog(service, renderRow.workspace_id);
  const entry = catalog.find((candidate) => candidate.id === request.model);
  if (!entry) throw new GameUiError("INVALID_MODEL", "This model is not available in this workspace");
  const { included, omitted } = limitReferencesToModel(
    renderPacket.data.reference_snapshot.map((reference) => ({ ...reference, borrowed: false })),
    entry.maxInputImages ?? 4,
    true,
  );
  const execution = await resolveImageExecutionPlan(
    client,
    {
      operation: "image_to_image",
      requestedModelId: request.model,
      styleId: style.id,
      sourceVersionId: renderRow.version_id,
      prompt: request.instruction,
      referenceIds: included.map((reference) => reference.id),
      costMode: request.costMode as never,
      count: 1,
      size: request.size,
      quality: request.quality,
      background: "transparent",
      preserveRequestedModel: true,
    },
    service,
  );
  const packet = compileGameUiPacket({
    intent: "element_reconstruction",
    styleId: style.id,
    styleRevision: renderPacket.data.style_revision,
    schema: renderPacket.data.schema_snapshot,
    instruction: request.instruction,
    screenId: renderRow.screen_id,
    renderId: renderRow.id,
    elementSetId: request.elementSetId,
    revisionId: element.id,
    element,
    sourceVersionId: renderRow.version_id,
    sourceContentHash,
    references: included,
    model: execution.effectiveModelId,
    size: request.size,
    quality: request.quality,
    costMode: request.costMode,
    requestId: request.requestId,
  });
  const planHash = hashGameUiPlan(packet);
  return {
    packet,
    planHash,
    plan: {
      intent: "element_reconstruction",
      operation: "image_to_image",
      requestedModelId: execution.requestedModelId,
      effectiveModelId: execution.effectiveModelId,
      provider: execution.provider,
      size: request.size,
      quality: request.quality,
      count: 1,
      referenceIds: packet.reference_snapshot.map((reference) => reference.id),
      omittedReferenceIds: omitted.map((reference) => reference.id),
      sourceVersionId: renderRow.version_id,
      modelChanged: execution.modelChanged,
      explanation: execution.explanation,
      supported: true,
      compiledPrompt: packet.compiled_prompt,
      planHash,
    },
  };
}
