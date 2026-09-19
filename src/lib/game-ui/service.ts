// Reads the Game UI module needs.  Routes and server-rendered pages share these
// so a page paints real content on first render instead of a skeleton.
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseElementDocument, parseScreenSpec, type ElementDocument, type ScreenSpec } from "./contracts";
import { parseGameUiStyleSchema, gameUiStyleWarnings, type GameUiStyleSchema } from "./style-schema";
import { parseGameUiConfirmedDefinition } from "@/lib/style/confirmed-definition";
import { getSignedUrls } from "@/lib/assets/service";
import { getStyleSetupState } from "@/lib/style/confirmed-definition";

export interface GameUiReferenceView {
  id: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  created_at: string;
  signed_url: string | null;
}

export interface GameUiStyleSummary {
  id: string;
  name: string;
  status: string;
  libraryId: string | null;
  referenceCount: number;
  screenCount: number;
  thumbnailUrl: string | null;
  updatedAt: string;
  setupState: string;
}

export interface GameUiStyleDetail {
  id: string;
  workspaceId: string;
  name: string;
  status: string;
  libraryId: string | null;
  schema: unknown;
  confirmedAt: string | null;
  styleRevision: string | null;
  analyzedAt: string | null;
  warnings: string[];
  grade: string | null;
  updatedAt: string;
  references: GameUiReferenceView[];
}

export interface GameUiScreenSummary {
  id: string;
  name: string;
  spec: ScreenSpec;
  draftRevision: number;
  wireframeVersionId: string | null;
  wireframeUrl: string | null;
  createdAt: string;
  updatedAt: string;
  renderCount: number;
}

export interface GameUiRenderSummary {
  id: string;
  screenId: string;
  assetId: string;
  versionId: string;
  width: number;
  height: number;
  createdAt: string;
  sourceUrl: string | null;
  jobId: string;
  jobStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  elementSetId: string | null;
  elementSetRevision: number | null;
  outputCount: number;
}

export interface GameUiOutputView {
  id: string;
  elementId: string;
  mode: "exact" | "reconstructed";
  alphaStatus: "transparent" | "opaque";
  reviewStatus: "pending" | "accepted" | "discarded";
  assetId: string;
  versionId: string;
  elementSetId: string;
  width: number;
  height: number;
  contentHash: string | null;
  provider: string | null;
  model: string | null;
  createdAt: string;
  url: string | null;
}

export interface GameUiRenderDetail {
  render: GameUiRenderSummary;
  spec: ScreenSpec;
  elementSet: { id: string; revision: number; document: ElementDocument } | null;
  outputs: GameUiOutputView[];
  outputsNextCursor: string | null;
}

type Cursor = { createdAt: string; id: string };

function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id } satisfies Cursor)).toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    return parsed && typeof parsed.createdAt === "string" && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function countRows(client: SupabaseClient, table: string, column: string, value: string): Promise<number> {
  const { count } = await client.from(table).select("id", { count: "exact", head: true }).eq(column, value);
  return count ?? 0;
}

/** Style cards for the module index: what it looks like and how far setup got. */
export async function listGameUiStyles(
  client: SupabaseClient,
  options: { libraryId?: string | null } = {},
): Promise<GameUiStyleSummary[]> {
  const query = client
    .from("styles")
    .select("id, name, status, library_id, schema, analysis_meta, confirmed_definition, updated_at, style_references(id, retired_at, storage_path, created_at)")
    .eq("domain", "game_ui")
    .order("updated_at", { ascending: false });
  if (options.libraryId) query.eq("library_id", options.libraryId);
  const { data, error } = await query;
  if (error) throw new Error("LOAD_FAILED");
  const rows = data ?? [];
  const styleIds = rows.map((row) => row.id as string);

  // One round trip each for the two counts and for the covers.
  const [screens, renders] = await Promise.all([
    styleIds.length > 0 ? client.from("game_ui_screens").select("id, style_id").in("style_id", styleIds) : Promise.resolve({ data: [] as Array<{ id: string; style_id: string }> }),
    styleIds.length > 0
      ? client.from("game_ui_renders").select("style_id, version_id, created_at").in("style_id", styleIds).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as Array<{ style_id: string; version_id: string; created_at: string }> }),
  ]);
  const screenCounts = new Map<string, number>();
  for (const screen of (screens.data ?? []) as Array<{ style_id: string }>) {
    screenCounts.set(screen.style_id, (screenCounts.get(screen.style_id) ?? 0) + 1);
  }
  const coverVersion = new Map<string, string>();
  for (const render of (renders.data ?? []) as Array<{ style_id: string; version_id: string }>) {
    if (!coverVersion.has(render.style_id)) coverVersion.set(render.style_id, render.version_id);
  }
  const versionIds = [...coverVersion.values()];
  const { data: versions } = versionIds.length > 0
    ? await client.from("asset_versions").select("id, storage_path").in("id", versionIds)
    : { data: [] as Array<{ id: string; storage_path: string }> };
  const pathByVersion = new Map<string, string>();
  for (const version of (versions ?? []) as Array<{ id: string; storage_path: string }>) pathByVersion.set(version.id, version.storage_path);

  const fallbackPath = new Map<string, string>();
  for (const row of rows) {
    const references = (row.style_references ?? []) as Array<{ retired_at: string | null; storage_path: string; created_at: string }>;
    const live = references.filter((reference) => reference.retired_at === null).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (live.length > 0) fallbackPath.set(row.id as string, live[0].storage_path);
  }
  const signed = await getSignedUrls(client, [
    ...versionIds.map((versionId) => pathByVersion.get(versionId) ?? null),
    ...[...fallbackPath.values()],
  ]);

  return rows.map((row) => {
    const id = row.id as string;
    const references = (row.style_references ?? []) as Array<{ retired_at: string | null }>;
    const referenceCount = references.filter((reference) => reference.retired_at === null).length;
    const coverVersionId = coverVersion.get(id);
    const coverPath = coverVersionId ? pathByVersion.get(coverVersionId) ?? null : fallbackPath.get(id) ?? null;
    return {
      id,
      name: row.name as string,
      status: row.status as string,
      libraryId: (row.library_id as string | null) ?? null,
      referenceCount,
      screenCount: screenCounts.get(id) ?? 0,
      thumbnailUrl: coverPath ? signed.get(coverPath) ?? null : null,
      updatedAt: row.updated_at as string,
      setupState: getStyleSetupState(
        { status: row.status as string, schema: row.schema, analysis_meta: row.analysis_meta, confirmed_definition: row.confirmed_definition },
        referenceCount,
      ),
    };
  });
}

/** The candidate plus what it was confirmed into, for the style review screen. */
export async function getGameUiStyleDetail(client: SupabaseClient, styleId: string): Promise<GameUiStyleDetail | null> {
  const { data: style } = await client.from("styles").select("*").eq("id", styleId).maybeSingle();
  if (!style || style.domain !== "game_ui") return null;
  const { data: referenceRows } = await client
    .from("style_references")
    .select("id, storage_path, mime_type, byte_size, width, height, created_at")
    .eq("style_id", styleId)
    .is("retired_at", null)
    .order("created_at");
  const signed = await getSignedUrls(client, (referenceRows ?? []).map((reference) => reference.storage_path as string));

  let schema: GameUiStyleSchema | null = null;
  let warnings: string[] = [];
  try {
    schema = parseGameUiStyleSchema(style.schema);
    warnings = gameUiStyleWarnings(schema);
  } catch {
    schema = null;
  }
  let revision: string | null = null;
  let confirmedAt: string | null = null;
  try {
    const confirmed = parseGameUiConfirmedDefinition(style.confirmed_definition ?? null);
    revision = confirmed?.style_revision ?? null;
    confirmedAt = confirmed?.confirmed_at ?? null;
  } catch {
    revision = null;
  }
  const analysisMeta = (style.analysis_meta ?? {}) as Record<string, unknown>;
  const recordedWarnings = Array.isArray(analysisMeta.warnings)
    ? analysisMeta.warnings.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id: style.id as string,
    workspaceId: style.workspace_id as string,
    name: style.name as string,
    status: style.status as string,
    libraryId: (style.library_id as string | null) ?? null,
    schema,
    confirmedAt,
    styleRevision: revision,
    analyzedAt: typeof analysisMeta.analyzedAt === "string" ? analysisMeta.analyzedAt : null,
    // The recorded analysis warnings and the ones derived from the schema overlap
    // (an uncertainty is written from one and re-derived from the other), and the
    // same sentence twice reads like two separate problems.
    warnings: [...new Set([...recordedWarnings, ...warnings])],
    grade: ((style.operability ?? {}) as Record<string, unknown>).grade as string | null,
    updatedAt: style.updated_at as string,
    references: (referenceRows ?? []).map((reference) => ({
      id: reference.id as string,
      mime_type: reference.mime_type as string,
      byte_size: reference.byte_size as number,
      width: (reference.width as number | null) ?? null,
      height: (reference.height as number | null) ?? null,
      created_at: reference.created_at as string,
      signed_url: signed.get(reference.storage_path as string) ?? null,
    })),
  };
}

/** One wireframe is attached per draft, so its URL rides along with the screen. */
async function wireframeUrls(client: SupabaseClient, versionIds: readonly string[]): Promise<Map<string, string>> {
  if (versionIds.length === 0) return new Map();
  const { data: versions } = await client.from("asset_versions").select("id, storage_path").in("id", [...versionIds]);
  const pathByVersion = new Map((versions ?? []).map((version) => [version.id as string, version.storage_path as string]));
  const signed = await getSignedUrls(client, [...pathByVersion.values()]);
  const urls = new Map<string, string>();
  for (const [versionId, path] of pathByVersion) {
    const url = signed.get(path);
    if (url) urls.set(versionId, url);
  }
  return urls;
}

export async function listGameUiScreens(
  client: SupabaseClient,
  styleId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<{ screens: GameUiScreenSummary[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 25));
  const query = client
    .from("game_ui_screens")
    .select("id, name, draft_spec, draft_revision, wireframe_version_id, created_at, updated_at")
    .eq("style_id", styleId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  const cursor = decodeCursor(options.cursor);
  if (cursor) query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw new Error("LOAD_FAILED");
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const urls = await wireframeUrls(client, page.map((row) => row.wireframe_version_id as string).filter(Boolean));
  const counts = await Promise.all(page.map((row) => countRows(client, "game_ui_renders", "screen_id", row.id as string)));
  const screens = page.map((row, index) => ({
    id: row.id as string,
    name: row.name as string,
    spec: parseScreenSpec(row.draft_spec),
    draftRevision: row.draft_revision as number,
    wireframeVersionId: (row.wireframe_version_id as string | null) ?? null,
    wireframeUrl: row.wireframe_version_id ? urls.get(row.wireframe_version_id as string) ?? null : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    renderCount: counts[index],
  }));
  return { screens, nextCursor: hasMore ? encodeCursor(page[page.length - 1] as { created_at: string; id: string }) : null };
}

export async function getGameUiScreen(
  client: SupabaseClient,
  screenId: string,
): Promise<{ screen: GameUiScreenSummary; styleId: string; workspaceId: string } | null> {
  const { data: row } = await client.from("game_ui_screens").select("*").eq("id", screenId).maybeSingle();
  if (!row) return null;
  const urls = await wireframeUrls(client, row.wireframe_version_id ? [row.wireframe_version_id as string] : []);
  return {
    styleId: row.style_id as string,
    workspaceId: row.workspace_id as string,
    screen: {
      id: row.id as string,
      name: row.name as string,
      spec: parseScreenSpec(row.draft_spec),
      draftRevision: row.draft_revision as number,
      wireframeVersionId: (row.wireframe_version_id as string | null) ?? null,
      wireframeUrl: row.wireframe_version_id ? urls.get(row.wireframe_version_id as string) ?? null : null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      renderCount: await countRows(client, "game_ui_renders", "screen_id", screenId),
    },
  };
}

export async function listGameUiRenders(
  client: SupabaseClient,
  screenId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<{ renders: GameUiRenderSummary[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 25));
  const query = client
    .from("game_ui_renders")
    .select("id, screen_id, asset_id, version_id, job_id, created_at, spec_snapshot, style_revision")
    .eq("screen_id", screenId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  const cursor = decodeCursor(options.cursor);
  if (cursor) query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw new Error("LOAD_FAILED");
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const renders = await hydrateRenders(client, page);
  return { renders, nextCursor: hasMore ? encodeCursor(page[page.length - 1] as { created_at: string; id: string }) : null };
}

async function hydrateRenders(
  client: SupabaseClient,
  rows: readonly Record<string, unknown>[],
): Promise<GameUiRenderSummary[]> {
  const versionIds = rows.map((row) => row.version_id as string);
  const [{ data: versions }, { data: jobs }] = await Promise.all([
    versionIds.length > 0 ? client.from("asset_versions").select("id, storage_path, width, height").in("id", versionIds) : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    rows.length > 0
      ? client.from("ai_jobs").select("id, status, error_code, error_message").in("id", rows.map((row) => row.job_id as string))
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);
  const versionById = new Map((versions ?? []).map((version) => [version.id as string, version]));
  const jobById = new Map((jobs ?? []).map((job) => [job.id as string, job]));
  const signed = await getSignedUrls(client, versionIds.map((versionId) => (versionById.get(versionId)?.storage_path as string | undefined) ?? null));
  const [sets, outputCounts] = await Promise.all([
    rows.length > 0
      ? client.from("game_ui_element_sets").select("id, render_id, revision").in("render_id", rows.map((row) => row.id as string)).order("revision", { ascending: false })
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    Promise.all(rows.map((row) => countRows(client, "game_ui_element_outputs", "render_id", row.id as string))),
  ]);
  const latestSet = new Map<string, { id: string; revision: number }>();
  for (const set of (sets.data ?? []) as Array<{ id: string; render_id: string; revision: number }>) {
    if (!latestSet.has(set.render_id)) latestSet.set(set.render_id, { id: set.id, revision: set.revision });
  }
  return rows.map((row, index) => {
    const version = versionById.get(row.version_id as string);
    const job = jobById.get(row.job_id as string);
    const set = latestSet.get(row.id as string) ?? null;
    return {
      id: row.id as string,
      screenId: row.screen_id as string,
      assetId: row.asset_id as string,
      versionId: row.version_id as string,
      width: (version?.width as number | undefined) ?? 0,
      height: (version?.height as number | undefined) ?? 0,
      createdAt: row.created_at as string,
      sourceUrl: version ? signed.get(version.storage_path as string) ?? null : null,
      jobId: row.job_id as string,
      jobStatus: (job?.status as string | undefined) ?? "succeeded",
      errorCode: (job?.error_code as string | null | undefined) ?? null,
      errorMessage: (job?.error_message as string | null | undefined) ?? null,
      elementSetId: set?.id ?? null,
      elementSetRevision: set?.revision ?? null,
      outputCount: outputCounts[index] ?? 0,
    };
  });
}

export interface GameUiJobView {
  id: string;
  status: string;
  operation: string;
  model: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  resultUrls: string[];
}

/** Recent jobs of a Game UI style, for the workspace activity list. */
export async function listGameUiJobs(client: SupabaseClient, styleId: string, limit = 25): Promise<GameUiJobView[]> {
  const { data, error } = await client
    .from("ai_jobs")
    .select("id, status, operation, model, error_code, error_message, created_at, updated_at, input, output, version_id")
    .eq("style_id", styleId)
    .eq("module", "style")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(50, limit)));
  if (error) throw new Error("LOAD_FAILED");
  const rows = data ?? [];
  const versionIds = rows.map((row) => row.version_id as string | null).filter((id): id is string => Boolean(id));
  const { data: versions } = versionIds.length > 0
    ? await client.from("asset_versions").select("id, storage_path").in("id", versionIds)
    : { data: [] as Array<Record<string, unknown>> };
  const pathByVersion = new Map((versions ?? []).map((version) => [version.id as string, version.storage_path as string]));
  const signed = await getSignedUrls(client, [...pathByVersion.values()]);
  return rows.map((row) => {
    const path = row.version_id ? pathByVersion.get(row.version_id as string) : undefined;
    return {
      id: row.id as string,
      status: row.status as string,
      operation: row.operation as string,
      model: row.model as string,
      errorCode: (row.error_code as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      resultUrls: path && signed.get(path) ? [signed.get(path)!] : [],
    };
  });
}

export async function listGameUiOutputs(
  client: SupabaseClient,
  renderId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<{ outputs: GameUiOutputView[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 25));
  const query = client
    .from("game_ui_element_outputs")
    .select("id, element_id, mode, alpha_status, review_status, asset_id, version_id, element_set_id, source_bounds, provider, model, created_at")
    .eq("render_id", renderId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  const cursor = decodeCursor(options.cursor);
  if (cursor) query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw new Error("LOAD_FAILED");
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const versionIds = page.map((row) => row.version_id as string);
  const { data: versions } = versionIds.length > 0
    ? await client.from("asset_versions").select("id, storage_path, width, height, metadata").in("id", versionIds)
    : { data: [] as Array<Record<string, unknown>> };
  const versionById = new Map((versions ?? []).map((version) => [version.id as string, version]));
  const signed = await getSignedUrls(client, versionIds.map((versionId) => (versionById.get(versionId)?.storage_path as string | undefined) ?? null));
  const outputs = page.map((row) => {
    const version = versionById.get(row.version_id as string);
    const metadata = (version?.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id as string,
      elementId: row.element_id as string,
      mode: row.mode as "exact" | "reconstructed",
      alphaStatus: row.alpha_status as "transparent" | "opaque",
      reviewStatus: row.review_status as "pending" | "accepted" | "discarded",
      assetId: row.asset_id as string,
      versionId: row.version_id as string,
      elementSetId: row.element_set_id as string,
      width: (version?.width as number | undefined) ?? 0,
      height: (version?.height as number | undefined) ?? 0,
      contentHash: typeof metadata.content_hash === "string" ? metadata.content_hash : null,
      provider: (row.provider as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      createdAt: row.created_at as string,
      url: version ? signed.get(version.storage_path as string) ?? null : null,
    } satisfies GameUiOutputView;
  });
  return { outputs, nextCursor: hasMore ? encodeCursor(page[page.length - 1] as { created_at: string; id: string }) : null };
}

/** Everything the render page needs on first paint. */
export async function getGameUiRenderDetail(client: SupabaseClient, renderId: string, outputsCursor?: string | null): Promise<GameUiRenderDetail | null> {
  const { data: row } = await client.from("game_ui_renders").select("*").eq("id", renderId).maybeSingle();
  if (!row) return null;
  const [renders, setRows, outputs] = await Promise.all([
    hydrateRenders(client, [row]),
    client.from("game_ui_element_sets").select("id, revision, document").eq("render_id", renderId).order("revision", { ascending: false }).limit(1),
    listGameUiOutputs(client, renderId, { cursor: outputsCursor ?? null }),
  ]);
  const render = renders[0];
  if (!render) return null;
  const setRow = (setRows.data ?? [])[0] as { id: string; revision: number; document: unknown } | undefined;
  return {
    render,
    spec: parseScreenSpec(row.spec_snapshot),
    elementSet: setRow ? { id: setRow.id, revision: setRow.revision, document: parseElementDocument(setRow.document, { width: render.width, height: render.height }) } : null,
    outputs: outputs.outputs,
    outputsNextCursor: outputs.nextCursor,
  };
}
