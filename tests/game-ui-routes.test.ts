// @vitest-environment node
// Route-level guarantees for the Game UI screen/render APIs: the caller is
// verified first, ownership is proven before anything is written or charged, the
// draft and element-map compare-and-swap revisions come from the request, and the
// two paid analysis routes can never save.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/supabase/server", () => ({
  createClient: vi.fn(() => client),
  getServiceClient: vi.fn(() => client),
}));
vi.mock("../src/lib/ai/quota", () => ({ enforceAiQuota: vi.fn(async () => ({ ok: true })) }));
vi.mock("../src/lib/game-ui/screen-analysis", () => ({
  suggestGameUiScreenSpec: vi.fn(),
  detectGameUiElements: vi.fn(),
}));
vi.mock("../src/lib/game-ui/generation-plan", () => ({ resolveGameUiScreenPlan: vi.fn() }));
vi.mock("../src/lib/game-ui/service", () => ({
  listGameUiScreens: vi.fn(),
  getGameUiScreen: vi.fn(),
  listGameUiRenders: vi.fn(),
  getGameUiRenderDetail: vi.fn(),
}));

import { enforceAiQuota } from "../src/lib/ai/quota";
import { detectGameUiElements, suggestGameUiScreenSpec } from "../src/lib/game-ui/screen-analysis";
import { resolveGameUiScreenPlan } from "../src/lib/game-ui/generation-plan";
import type { GameUiGenerationPlanView } from "../src/lib/game-ui/generation-plan";
import { getGameUiRenderDetail, getGameUiScreen, listGameUiRenders, listGameUiScreens } from "../src/lib/game-ui/service";
import type { GameUiOutputView, GameUiRenderSummary, GameUiScreenSummary } from "../src/lib/game-ui/service";
import type { ElementDocument, ScreenRequirement, ScreenSpec } from "../src/lib/game-ui/contracts";
import { GET as listScreens, POST as createScreen } from "../src/app/api/game-ui/styles/[styleId]/screens/route";
import { GET as readScreen, PATCH as patchScreen } from "../src/app/api/game-ui/screens/[screenId]/route";
import { POST as suggestScreen } from "../src/app/api/game-ui/screens/[screenId]/suggest/route";
import { POST as planScreen } from "../src/app/api/game-ui/screens/[screenId]/plan/route";
import { GET as readRender } from "../src/app/api/game-ui/renders/[renderId]/route";
import { POST as detectElements } from "../src/app/api/game-ui/renders/[renderId]/detect/route";
import { PUT as saveElements } from "../src/app/api/game-ui/renders/[renderId]/elements/route";

const STYLE_ID = "11111111-1111-4111-8111-111111111111";
const SCREEN_ID = "22222222-2222-4222-8222-222222222222";
const RENDER_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const REQUIREMENT_ID = "66666666-6666-4666-8666-666666666666";
const ELEMENT_ID = "77777777-7777-4777-8777-777777777777";
const JOB_ID = "88888888-8888-4888-8888-888888888888";
const OUTPUT_ID = "99999999-9999-4999-8999-999999999999";
const MODEL = "openai/gpt-image-1";

type Result = { data: unknown; error: unknown };

function requirement(id = REQUIREMENT_ID): ScreenRequirement {
  return {
    id,
    kind: "button",
    custom_type: null,
    name: "Pause",
    purpose: "pause the battle",
    visible_text: "Pause",
    visible_state: null,
    required: true,
  };
}

function spec(requirements: ScreenRequirement[] = [requirement()]): ScreenSpec {
  return { schema_version: 1, name: "Battle HUD", description: "", layout_notes: "", requirements };
}

const BASE_DOCUMENT: ElementDocument = {
  schema_version: 1,
  render_id: RENDER_ID,
  source_version_id: VERSION_ID,
  canvas: { width: 1024, height: 768 },
  elements: [
    {
      id: ELEMENT_ID,
      parent_id: null,
      kind: "button",
      custom_type: null,
      name: "Pause",
      purpose: "",
      visible_text: "Pause",
      visible_state: null,
      bounds: { x: 10, y: 10, width: 100, height: 40 },
      z_index: 0,
      occluded: false,
      confidence: null,
      notes: "",
      reviewed: true,
    },
  ],
  coverage: [],
};

function elementDocument(overrides: Partial<ElementDocument> = {}): ElementDocument {
  return { ...BASE_DOCUMENT, ...overrides };
}

const screenSummary: GameUiScreenSummary = {
  id: SCREEN_ID,
  name: "Battle HUD",
  spec: spec(),
  draftRevision: 4,
  wireframeVersionId: null,
  wireframeUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  renderCount: 1,
};

const renderSummary: GameUiRenderSummary = {
  id: RENDER_ID,
  screenId: SCREEN_ID,
  assetId: ASSET_ID,
  versionId: VERSION_ID,
  width: 1024,
  height: 768,
  createdAt: "2026-01-01T00:00:00Z",
  sourceUrl: null,
  jobId: JOB_ID,
  jobStatus: "succeeded",
  errorCode: null,
  errorMessage: null,
  elementSetId: null,
  elementSetRevision: null,
  outputCount: 0,
};

const outputView: GameUiOutputView = {
  id: OUTPUT_ID,
  elementId: ELEMENT_ID,
  mode: "exact",
  alphaStatus: "transparent",
  reviewStatus: "pending",
  assetId: ASSET_ID,
  versionId: VERSION_ID,
  elementSetId: "set-1",
  width: 100,
  height: 40,
  contentHash: "hash",
  provider: null,
  model: null,
  createdAt: "2026-01-01T00:00:00Z",
  url: null,
};

const planView: GameUiGenerationPlanView = {
  intent: "screen",
  operation: "text_to_image",
  requestedModelId: MODEL,
  effectiveModelId: MODEL,
  provider: "openai",
  size: "1024x1024",
  quality: "high",
  count: 2,
  referenceIds: [ASSET_ID],
  omittedReferenceIds: [],
  sourceVersionId: null,
  modelChanged: false,
  explanation: "text to image",
  supported: true,
  compiledPrompt: "STYLE ...",
  planHash: "hash-1",
};

const styleRow = { id: STYLE_ID, workspace_id: "ws-1", status: "active", domain: "game_ui", library_id: null, confirmed_definition: null };
const screenRow = { id: SCREEN_ID, style_id: STYLE_ID, workspace_id: "ws-1", name: "Battle HUD", draft_revision: 4, wireframe_version_id: null };
const renderRow = { id: RENDER_ID, style_id: STYLE_ID, screen_id: SCREEN_ID, workspace_id: "ws-1", asset_id: ASSET_ID, version_id: VERSION_ID };
const versionRow = { id: VERSION_ID, width: 1024, height: 768 };

let client: Record<string, unknown>;
// Keyed by table so a route's own reads (styles, render, version, element sets)
// resolve to the row that test needs.
const tables = new Map<string, Result>();
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const getClaims = vi.fn<() => Promise<{ data: { claims: Record<string, unknown> } | null; error: unknown }>>(
  async () => ({ data: { claims: { sub: "user-1", email: "user@example.com" } }, error: null }),
);
let rpcResult: Result;

// Supabase builders are awaitable at any chain position, so every step returns
// the same thenable node and the terminal readers return the configured row.
function queryNode(result: Result) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "order", "limit"]) node[method] = vi.fn(() => node);
  node.maybeSingle = vi.fn(async () => result);
  node.single = vi.fn(async () => result);
  node.then = (onFulfilled: (value: Result) => unknown) => Promise.resolve(result).then(onFulfilled);
  return node;
}

function jsonRequest(body?: unknown, method = "POST") {
  return new Request("http://localhost", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ctx<T extends Record<string, string>>(keys: T) {
  return { params: Promise.resolve(keys) };
}

function routes() {
  return [
    { name: "POST /api/game-ui/styles/[styleId]/screens", run: () => createScreen(jsonRequest({ name: "Battle HUD", spec: spec() }), ctx({ styleId: STYLE_ID })) },
    { name: "GET /api/game-ui/styles/[styleId]/screens", run: () => listScreens(new Request("http://localhost"), ctx({ styleId: STYLE_ID })) },
    { name: "GET /api/game-ui/screens/[screenId]", run: () => readScreen(new Request("http://localhost"), ctx({ screenId: SCREEN_ID })) },
    { name: "PATCH /api/game-ui/screens/[screenId]", run: () => patchScreen(jsonRequest({ expectedRevision: 4, name: "Battle HUD", spec: spec(), wireframeVersionId: null }, "PATCH"), ctx({ screenId: SCREEN_ID })) },
    { name: "POST /api/game-ui/screens/[screenId]/suggest", run: () => suggestScreen(jsonRequest({ expectedRevision: 4 }), ctx({ screenId: SCREEN_ID })) },
    { name: "POST /api/game-ui/screens/[screenId]/plan", run: () => planScreen(jsonRequest({ expectedRevision: 4, model: MODEL, size: "1024x1024", quality: "auto", count: 1, referenceIds: [ASSET_ID] }), ctx({ screenId: SCREEN_ID })) },
    { name: "GET /api/game-ui/renders/[renderId]", run: () => readRender(new Request("http://localhost"), ctx({ renderId: RENDER_ID })) },
    { name: "POST /api/game-ui/renders/[renderId]/detect", run: () => detectElements(jsonRequest({ expectedRevision: 0 }), ctx({ renderId: RENDER_ID })) },
    { name: "PUT /api/game-ui/renders/[renderId]/elements", run: () => saveElements(jsonRequest({ expectedRevision: 0, document: elementDocument() }, "PUT"), ctx({ renderId: RENDER_ID })) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  rpcCalls.length = 0;
  rpcResult = { data: { id: SCREEN_ID, draft_revision: 1 }, error: null };
  tables.set("styles", { data: styleRow, error: null });
  tables.set("game_ui_screens", { data: screenRow, error: null });
  tables.set("game_ui_renders", { data: renderRow, error: null });
  tables.set("asset_versions", { data: versionRow, error: null });
  tables.set("game_ui_element_sets", { data: null, error: null });
  client = {
    auth: { getClaims },
    from: vi.fn((table: string) => queryNode(tables.get(table) ?? { data: null, error: null })),
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return queryNode(rpcResult);
    }),
  };
  getClaims.mockResolvedValue({ data: { claims: { sub: "user-1", email: "user@example.com" } }, error: null });
  vi.mocked(enforceAiQuota).mockResolvedValue({ ok: true });
  vi.mocked(suggestGameUiScreenSpec).mockResolvedValue({ spec: spec(), expectedRevision: 4, warnings: ["no wireframe"] });
  vi.mocked(detectGameUiElements).mockResolvedValue({ document: elementDocument(), expectedRevision: 0, warnings: [] });
  vi.mocked(resolveGameUiScreenPlan).mockResolvedValue({ plan: planView, packet: {} as never, planHash: "hash-1" });
  vi.mocked(listGameUiScreens).mockResolvedValue({ screens: [screenSummary], nextCursor: "next-screen" });
  vi.mocked(getGameUiScreen).mockResolvedValue({ screen: screenSummary, styleId: STYLE_ID, workspaceId: "ws-1" });
  vi.mocked(listGameUiRenders).mockResolvedValue({ renders: [renderSummary], nextCursor: "next-render" });
  vi.mocked(getGameUiRenderDetail).mockResolvedValue({
    render: renderSummary,
    spec: spec(),
    elementSet: null,
    outputs: [outputView],
    outputsNextCursor: "next-output",
  });
});

describe("authentication", () => {
  it("answers 401 before any lookup or write when there is no verified user", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    for (const route of routes()) {
      const response = await route.run();
      expect(response.status, route.name).toBe(401);
      expect(await response.json(), route.name).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    }
    expect(rpcCalls).toEqual([]);
  });
});

describe("screen drafts", () => {
  it("creates a screen with revision 0 and the caller's specification", async () => {
    const response = await createScreen(
      jsonRequest({ name: "Battle HUD", spec: spec(), wireframeVersionId: VERSION_ID }),
      ctx({ styleId: STYLE_ID }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ screen: rpcResult.data });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("save_game_ui_screen");
    expect(rpcCalls[0].args).toMatchObject({
      p_style_id: STYLE_ID,
      p_expected_revision: 0,
      p_name: "Battle HUD",
      p_wireframe_version_id: VERSION_ID,
    });
    expect(rpcCalls[0].args.p_screen_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rpcCalls[0].args.p_spec).toEqual(spec());
  });

  it("answers 404 for a style that is missing or is not a Game UI style", async () => {
    tables.set("styles", { data: null, error: null });
    const missing = await createScreen(jsonRequest({ name: "Battle HUD", spec: spec() }), ctx({ styleId: STYLE_ID }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "Style not found" } });

    tables.set("styles", { data: { ...styleRow, domain: "visual" }, error: null });
    const visual = await createScreen(jsonRequest({ name: "Battle HUD", spec: spec() }), ctx({ styleId: STYLE_ID }));
    expect(visual.status).toBe(404);
    expect(rpcCalls).toEqual([]);
  });

  it("rejects a specification whose requirements repeat an id", async () => {
    const response = await createScreen(jsonRequest({ name: "Battle HUD", spec: spec([requirement(), requirement()]) }), ctx({ styleId: STYLE_ID }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toMatch(/Two requirements share the id/);
    expect(rpcCalls).toEqual([]);
  });

  it("patches with the caller's expected revision", async () => {
    rpcResult = { data: { id: SCREEN_ID, draft_revision: 5 }, error: null };
    const response = await patchScreen(
      jsonRequest({ expectedRevision: 4, name: "Battle HUD v2", spec: spec(), wireframeVersionId: null }, "PATCH"),
      ctx({ screenId: SCREEN_ID }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ screen: rpcResult.data });
    expect(rpcCalls[0].args).toMatchObject({
      p_style_id: STYLE_ID,
      p_screen_id: SCREEN_ID,
      p_expected_revision: 4,
      p_name: "Battle HUD v2",
      p_wireframe_version_id: null,
    });
  });

  it("passes a stale-draft conflict through as 409", async () => {
    rpcResult = { data: null, error: { code: "23000", message: "SCREEN_VERSION_CONFLICT" } };
    const response = await patchScreen(
      jsonRequest({ expectedRevision: 3, name: "Battle HUD", spec: spec(), wireframeVersionId: null }, "PATCH"),
      ctx({ screenId: SCREEN_ID }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "SCREEN_VERSION_CONFLICT", message: "SCREEN_VERSION_CONFLICT" } });
  });

  it("lists screens and rejects a limit outside 1-50", async () => {
    const response = await listScreens(new Request("http://localhost?limit=10&cursor=abc"), ctx({ styleId: STYLE_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ screens: [screenSummary], nextCursor: "next-screen" });
    expect(vi.mocked(listGameUiScreens).mock.calls[0][2]).toEqual({ limit: 10, cursor: "abc" });

    const bad = await listScreens(new Request("http://localhost?limit=51"), ctx({ styleId: STYLE_ID }));
    expect(bad.status).toBe(400);
  });

  it("returns one screen with its renders and answers 404 for a foreign screen", async () => {
    const response = await readScreen(new Request("http://localhost"), ctx({ screenId: SCREEN_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ screen: screenSummary, renders: [renderSummary], nextCursor: "next-render" });

    vi.mocked(getGameUiScreen).mockResolvedValue(null);
    const missing = await readScreen(new Request("http://localhost"), ctx({ screenId: SCREEN_ID }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("SCREEN_NOT_FOUND");
  });
});

describe("paid analysis routes", () => {
  it("returns a suggestion without saving it", async () => {
    const response = await suggestScreen(jsonRequest({ expectedRevision: 4 }), ctx({ screenId: SCREEN_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ spec: spec(), expectedRevision: 4, warnings: ["no wireframe"] });
    expect(vi.mocked(suggestGameUiScreenSpec).mock.calls[0][2]).toEqual({ screenId: SCREEN_ID, expectedRevision: 4 });
    expect(rpcCalls).toEqual([]);
  });

  it("returns a detection without saving it", async () => {
    const response = await detectElements(jsonRequest({ expectedRevision: 0 }), ctx({ renderId: RENDER_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: elementDocument(), expectedRevision: 0, warnings: [] });
    expect(vi.mocked(detectGameUiElements).mock.calls[0][2]).toEqual({ renderId: RENDER_ID });
    expect(rpcCalls).toEqual([]);
  });

  it("refuses a detection against a stale element map before paying for it", async () => {
    tables.set("game_ui_element_sets", { data: { id: "set-1", revision: 4, document: elementDocument() }, error: null });
    const response = await detectElements(jsonRequest({ expectedRevision: 2 }), ctx({ renderId: RENDER_ID }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "SCREEN_VERSION_CONFLICT", message: "The element map changed since it was loaded; reload it" },
      expectedRevision: 4,
    });
    expect(detectGameUiElements).not.toHaveBeenCalled();
    expect(enforceAiQuota).not.toHaveBeenCalled();
  });

  it("stops at the quota gate before calling suggest or detect", async () => {
    vi.mocked(enforceAiQuota).mockResolvedValue({
      ok: false,
      response: Response.json({ error: { code: "quota_exceeded", message: "Daily AI quota reached" } }, { status: 429 }),
    });
    const suggestion = await suggestScreen(jsonRequest({ expectedRevision: 4 }), ctx({ screenId: SCREEN_ID }));
    expect(suggestion.status).toBe(429);
    expect(suggestGameUiScreenSpec).not.toHaveBeenCalled();

    const detection = await detectElements(jsonRequest({ expectedRevision: 0 }), ctx({ renderId: RENDER_ID }));
    expect(detection.status).toBe(429);
    expect(detectGameUiElements).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it("answers 404 for the analysis routes of a foreign screen or render", async () => {
    tables.set("game_ui_screens", { data: null, error: null });
    const suggestion = await suggestScreen(jsonRequest({ expectedRevision: 4 }), ctx({ screenId: SCREEN_ID }));
    expect(suggestion.status).toBe(404);

    tables.set("game_ui_renders", { data: null, error: null });
    const detection = await detectElements(jsonRequest({ expectedRevision: 0 }), ctx({ renderId: RENDER_ID }));
    expect(detection.status).toBe(404);
    expect(suggestGameUiScreenSpec).not.toHaveBeenCalled();
    expect(detectGameUiElements).not.toHaveBeenCalled();
  });
});

describe("generation plan", () => {
  it("previews the plan with a fresh request id and never enqueues", async () => {
    const response = await planScreen(
      jsonRequest({ expectedRevision: 4, model: MODEL, size: "1024x1024", quality: "high", count: 2, referenceIds: [ASSET_ID] }),
      ctx({ screenId: SCREEN_ID }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: planView });
    const call = vi.mocked(resolveGameUiScreenPlan).mock.calls[0][2];
    expect(call).toMatchObject({
      screenId: SCREEN_ID,
      expectedRevision: 4,
      model: MODEL,
      size: "1024x1024",
      quality: "high",
      count: 2,
      referenceIds: [ASSET_ID],
      costMode: "strict_1000",
    });
    expect(call.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rpcCalls).toEqual([]);
  });

  it("rejects a plan request without references", async () => {
    const response = await planScreen(
      jsonRequest({ expectedRevision: 4, model: MODEL, size: "1024x1024", quality: "auto", count: 1, referenceIds: [] }),
      ctx({ screenId: SCREEN_ID }),
    );
    expect(response.status).toBe(400);
    expect(resolveGameUiScreenPlan).not.toHaveBeenCalled();
  });
});

describe("render detail", () => {
  it("returns the render with its specification, element map and outputs", async () => {
    vi.mocked(getGameUiRenderDetail).mockResolvedValue({
      render: renderSummary,
      spec: spec(),
      elementSet: { id: "set-1", revision: 2, document: elementDocument() },
      outputs: [outputView],
      outputsNextCursor: "next-output",
    });
    const response = await readRender(new Request("http://localhost?outputsCursor=abc"), ctx({ renderId: RENDER_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      render: renderSummary,
      spec: spec(),
      elementSet: { id: "set-1", revision: 2, document: elementDocument() },
      outputs: [outputView],
      outputsNextCursor: "next-output",
    });
    expect(vi.mocked(getGameUiRenderDetail).mock.calls[0][2]).toBe("abc");
  });

  it("answers 404 for a foreign render", async () => {
    tables.set("game_ui_renders", { data: null, error: null });
    const response = await readRender(new Request("http://localhost"), ctx({ renderId: RENDER_ID }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("RENDER_NOT_FOUND");
  });
});

describe("element maps", () => {
  it("saves the map under the caller's expected revision", async () => {
    rpcResult = { data: { id: "set-1", revision: 4, document: elementDocument() }, error: null };
    const response = await saveElements(
      jsonRequest({ expectedRevision: 3, document: elementDocument() }, "PUT"),
      ctx({ renderId: RENDER_ID }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ elementSet: rpcResult.data });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("save_game_ui_elements");
    expect(rpcCalls[0].args).toMatchObject({ p_render_id: RENDER_ID, p_expected_revision: 3 });
    expect(rpcCalls[0].args.p_document).toEqual(elementDocument());
  });

  it("passes a stale element-map conflict through as 409", async () => {
    rpcResult = { data: null, error: { code: "23000", message: "SCREEN_VERSION_CONFLICT" } };
    const response = await saveElements(
      jsonRequest({ expectedRevision: 2, document: elementDocument() }, "PUT"),
      ctx({ renderId: RENDER_ID }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SCREEN_VERSION_CONFLICT");
  });

  it("rejects a map drawn against different dimensions and one from another render", async () => {
    const wrongCanvas = await saveElements(
      jsonRequest({ expectedRevision: 0, document: elementDocument({ canvas: { width: 512, height: 512 } }) }, "PUT"),
      ctx({ renderId: RENDER_ID }),
    );
    expect(wrongCanvas.status).toBe(400);
    expect((await wrongCanvas.json()).error.message).toMatch(/does not match the image/);

    const wrongRender = await saveElements(
      jsonRequest({ expectedRevision: 0, document: elementDocument({ render_id: STYLE_ID }) }, "PUT"),
      ctx({ renderId: RENDER_ID }),
    );
    expect(wrongRender.status).toBe(400);
    expect((await wrongRender.json()).error.message).toMatch(/another generated screen/);
    expect(rpcCalls).toEqual([]);
  });

  it("answers 404 when the render's image version is gone", async () => {
    tables.set("asset_versions", { data: null, error: null });
    const response = await saveElements(
      jsonRequest({ expectedRevision: 0, document: elementDocument() }, "PUT"),
      ctx({ renderId: RENDER_ID }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("RENDER_NOT_FOUND");
    expect(rpcCalls).toEqual([]);
  });
});
