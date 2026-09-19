// @vitest-environment node
// Planning a Game UI generation: the consent hash, the reference bound and the
// authority a reconstruction is pinned to.  Provider access is mocked, so these
// checks are about what the server decides before anything is charged.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GameUiError } from "@/lib/game-ui/errors";
import { compileGameUiPacket, type GameUiGenerationPacket } from "@/lib/game-ui/generation-packet";
import { hashGameUiPlan, resolveGameUiReconstructionPlan, resolveGameUiScreenPlan } from "@/lib/game-ui/generation-plan";

const mockResolveImageExecutionPlan = vi.fn();
const mockGetModelCatalog = vi.fn();

vi.mock("@/lib/ai/execution-plan", () => ({
  resolveImageExecutionPlan: (...args: unknown[]) => mockResolveImageExecutionPlan(...args),
}));
vi.mock("@/lib/ai/models", () => ({
  getModelCatalog: (...args: unknown[]) => mockGetModelCatalog(...args),
}));

/** Minimal PostgREST-shaped double: rows keyed by table, eq/in/order supported. */
function fakeClient(tables: Record<string, Array<Record<string, unknown>>>) {
  function builder(table: string) {
    const rows = () => [...(tables[table] ?? [])];
    const filters: Array<{ column: string; value: unknown; kind: "eq" | "in" | "is" }> = [];
    let limit: number | null = null;
    let orderBy: { column: string; ascending: boolean } | null = null;
    const matches = () =>
      rows()
        .filter((row) =>
          filters.every((filter) =>
            filter.kind === "eq"
              ? row[filter.column] === filter.value
              : filter.kind === "is"
                ? row[filter.column] === null
                : Array.isArray(filter.value) && (filter.value as unknown[]).includes(row[filter.column]),
          ),
        )
        .sort((a, b) =>
          orderBy
            ? (orderBy.ascending ? 1 : -1) * (Number(a[orderBy.column]) - Number(b[orderBy.column]) || String(a[orderBy.column]).localeCompare(String(b[orderBy.column])))
            : 0,
        )
        .slice(0, limit ?? undefined);
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value, kind: "eq" });
        return chain;
      },
      in: (column: string, value: unknown) => {
        filters.push({ column, value, kind: "in" });
        return chain;
      },
      is: (column: string, value: unknown) => {
        filters.push({ column, value, kind: "is" });
        return chain;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orderBy = { column, ascending: options?.ascending !== false };
        return chain;
      },
      limit: (value: number) => {
        limit = value;
        return chain;
      },
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
      single: async () => ({ data: matches()[0] ?? null, error: null }),
      then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve({ data: matches(), error: null }).then(onFulfilled),
    };
    return chain;
  }
  return { from: (table: string) => builder(table) } as never;
}

const STYLE_ID = "66666666-6666-4666-8666-666666666666";
const SCREEN_ID = "dddddddd-1111-4111-8111-111111111111";
const RENDER_ID = "eeeeeeee-1111-4111-8111-111111111111";
const SET_ID = "ffffffff-1111-4111-8111-111111111111";
const ELEMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const RENDER_VERSION_ID = "88888888-8888-4888-8888-888888888888";
const REQUEST_ID = "bbbbbbbb-1111-4111-8111-111111111111";
const REF_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const REF_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const REF_C = "33333333-cccc-4ccc-8ccc-333333333333";

const styleSchema = {
  schema_version: 1,
  domain: "game_ui",
  name: "Arcane HUD",
  visual_language: "Painted gold chrome",
  palette: [{ id: "gold", role: "accent", color: "#d4a24a", notes: "" }],
  typography: [{ role: "button", family_description: "serif", weight: "bold", casing: "uppercase", effects: "" }],
  layout: { density: "balanced", spacing_rules: "", alignment_rules: "", safe_area_rules: "", hierarchy_rules: "" },
  shape: { corner_rules: "", border_rules: "", silhouette_rules: "" },
  surface: { materials: "", shading: "", shadows: "", highlights: "" },
  iconography: { construction: "", stroke_rules: "", detail_level: "" },
  components: [{ kind: "button", appearance: "gold frame", text_rules: "", composition_rules: "" }],
  invariants: ["gold bevel on every frame"],
  avoid: [],
  uncertainties: [],
};

const spec = {
  schema_version: 1,
  name: "Battle HUD",
  description: "Top bar with the health bar",
  layout_notes: "",
  requirements: [
    { id: "44444444-dddd-4ddd-8ddd-444444444444", kind: "health_bar", custom_type: null, name: "Health", purpose: "", visible_text: null, visible_state: null, required: true },
  ],
};

const element = {
  id: ELEMENT_ID,
  parent_id: null,
  kind: "button",
  custom_type: null,
  name: "Continue",
  purpose: "",
  visible_text: "Continue",
  visible_state: null,
  bounds: { x: 4, y: 4, width: 40, height: 20 },
  z_index: 0,
  occluded: false,
  confidence: null,
  notes: "",
  reviewed: true,
};

const document = {
  schema_version: 1,
  render_id: RENDER_ID,
  source_version_id: RENDER_VERSION_ID,
  canvas: { width: 1024, height: 768 },
  elements: [element],
  coverage: [],
};

const revision = "99999999-9999-4999-8999-999999999999";

function tables(overrides: Record<string, Array<Record<string, unknown>>> = {}): Record<string, Array<Record<string, unknown>>> {
  return {
    styles: [
      {
        id: STYLE_ID,
        workspace_id: "11111111-1111-4111-8111-111111111111",
        name: "Arcane HUD",
        status: "active",
        domain: "game_ui",
        schema: styleSchema,
        library_id: null,
        confirmed_definition: {
          definition_version: 2,
          domain: "game_ui",
          style_revision: revision,
          schema_snapshot: styleSchema,
          reference_snapshot: [{ id: REF_A, content_hash: "a".repeat(64) }],
          confirmed_at: "2026-09-18T00:00:00.000Z",
        },
      },
    ],
    game_ui_screens: [
      { id: SCREEN_ID, workspace_id: "11111111-1111-4111-8111-111111111111", style_id: STYLE_ID, name: "Battle HUD", draft_spec: spec, draft_revision: 3, wireframe_version_id: null },
    ],
    game_ui_renders: [
      {
        id: RENDER_ID,
        workspace_id: "11111111-1111-4111-8111-111111111111",
        style_id: STYLE_ID,
        screen_id: SCREEN_ID,
        asset_id: "77777777-7777-4777-8777-777777777777",
        version_id: RENDER_VERSION_ID,
        spec_snapshot: spec,
        style_revision: revision,
      },
    ],
    game_ui_element_sets: [{ id: SET_ID, render_id: RENDER_ID, revision: 2, document }],
    style_references: [
      { id: REF_A, style_id: STYLE_ID, content_hash: "a".repeat(64), retired_at: null, styles: { id: STYLE_ID, workspace_id: "11111111-1111-4111-8111-111111111111", library_id: null, domain: "game_ui" } },
      { id: REF_B, style_id: STYLE_ID, content_hash: "b".repeat(64), retired_at: null, styles: { id: STYLE_ID, workspace_id: "11111111-1111-4111-8111-111111111111", library_id: null, domain: "game_ui" } },
      { id: REF_C, style_id: STYLE_ID, content_hash: "c".repeat(64), retired_at: null, styles: { id: STYLE_ID, workspace_id: "11111111-1111-4111-8111-111111111111", library_id: null, domain: "game_ui" } },
    ],
    asset_versions: [
      { id: RENDER_VERSION_ID, asset_id: "77777777-7777-4777-8777-777777777777", width: 1024, height: 768, metadata: { content_hash: "d".repeat(64) }, style_generation: renderPacket() },
    ],
    ...overrides,
  };
}


/** The packet a screen render would have been produced from. */
function renderPacket() {
  return compileGameUiPacket({
    intent: "screen",
    styleId: STYLE_ID,
    styleRevision: revision,
    schema: styleSchema as never,
    spec: spec as never,
    screenId: SCREEN_ID,
    draftRevision: 3,
    wireframeInputId: null,
    sourceVersionId: null,
    sourceContentHash: null,
    references: [{ id: REF_A, content_hash: "a".repeat(64) }],
    operation: "text_to_image",
    model: "openai/gpt-image-2",
    size: "1024x1024",
    quality: "low",
    count: 1,
    requestId: REQUEST_ID,
  });
}

const executionPlan = {
  operation: "text_to_image",
  requestedModelId: "openai/gpt-image-2",
  effectiveModelId: "openai/gpt-image-2",
  provider: "openai",
  size: "1024x1024",
  quality: "low",
  count: 1,
  styleBudget: 1600,
  referenceIds: [REF_A, REF_B, REF_C],
  sourceVersionId: null,
  temperature: null,
  modelChanged: false,
  explanation: "Requested model supports the requested operation and settings.",
  supported: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetModelCatalog.mockResolvedValue([{ id: "openai/gpt-image-2", provider: "openai", maxInputImages: 4, operations: ["text_to_image", "image_to_image"], sizes: ["1024x1024"], qualities: ["low"], maxCount: 4, supportsReferenceImages: true, supportsTransparentBackground: true }]);
  mockResolveImageExecutionPlan.mockResolvedValue(executionPlan);
});

describe("game ui planning", () => {
  it("keeps the consent hash stable across request ids but sensitive to the plan", async () => {
    const base = {
      packet_version: 2,
      domain: "game_ui",
      style_id: STYLE_ID,
      style_revision: revision,
      schema_snapshot: styleSchema,
      operation: "text_to_image",
      original_prompt: "Battle HUD",
      compiled_prompt: "STYLE ... SCREEN ...",
      reference_snapshot: [{ id: REF_A, content_hash: "a".repeat(64) }],
      source_version_id: null,
      model: "openai/gpt-image-2",
      size: "1024x1024",
      quality: "low",
      count: 1,
      intent: "screen",
      context: { screen_id: SCREEN_ID, draft_revision: 3, spec_snapshot: spec, wireframe_input_id: null, source_content_hash: null, request_id: REQUEST_ID },
    } as unknown as GameUiGenerationPacket;
    const first = hashGameUiPlan(base);
    const otherRequest = hashGameUiPlan({ ...base, context: { ...base.context, request_id: "00000000-0000-4000-8000-000000000000" } } as GameUiGenerationPacket);
    expect(otherRequest).toBe(first);
    const otherDraft = hashGameUiPlan({ ...base, context: { ...base.context, draft_revision: 4 } } as GameUiGenerationPacket);
    expect(otherDraft).not.toBe(first);
    const otherRefs = hashGameUiPlan({ ...base, reference_snapshot: [{ id: REF_B, content_hash: "b".repeat(64) }] } as GameUiGenerationPacket);
    expect(otherRefs).not.toBe(first);
  });

  it("refuses to plan against a draft revision the screen no longer has", async () => {
    const client = fakeClient(tables());
    await expect(
      resolveGameUiScreenPlan(client, client, {
        screenId: SCREEN_ID,
        expectedRevision: 1,
        model: "openai/gpt-image-2",
        size: "1024x1024",
        quality: "low",
        count: 1,
        referenceIds: [REF_A],
        costMode: "strict_1000",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "SCREEN_VERSION_CONFLICT" });
    expect(mockResolveImageExecutionPlan).not.toHaveBeenCalled();
  });

  it("drops the tail of the reference selection when the model accepts fewer images and reports it", async () => {
    mockGetModelCatalog.mockResolvedValue([{ id: "openai/gpt-image-2", provider: "openai", maxInputImages: 2, operations: ["text_to_image"], sizes: ["1024x1024"], qualities: ["low"], maxCount: 4, supportsReferenceImages: true }]);
    const client = fakeClient(tables());
    const result = await resolveGameUiScreenPlan(client, client, {
      screenId: SCREEN_ID,
      expectedRevision: 3,
      model: "openai/gpt-image-2",
      size: "1024x1024",
      quality: "low",
      count: 1,
      referenceIds: [REF_A, REF_B, REF_C],
      costMode: "strict_1000",
      requestId: REQUEST_ID,
    });
    expect(result.packet.reference_snapshot.map((reference) => reference.id)).toEqual([REF_A, REF_B]);
    expect(result.plan.omittedReferenceIds).toEqual([REF_C]);
    expect(result.packet.intent).toBe("screen");
    expect(result.packet.context).toMatchObject({ screen_id: SCREEN_ID, draft_revision: 3 });
  });

  it("refuses a model that cannot carry the wireframe and a style reference", async () => {
    mockGetModelCatalog.mockResolvedValue([{ id: "openai/gpt-image-2", provider: "openai", maxInputImages: 1, operations: ["image_to_image"], sizes: ["1024x1024"], qualities: ["low"], maxCount: 4, supportsReferenceImages: true }]);
    const withWireframe = tables();
    withWireframe.game_ui_screens = [{ ...withWireframe.game_ui_screens[0], wireframe_version_id: RENDER_VERSION_ID }];
    withWireframe.game_ui_inputs = [{ id: "55555555-eeee-4eee-8eee-555555555555", version_id: RENDER_VERSION_ID, content_hash: "e".repeat(64), kind: "wireframe", style_id: STYLE_ID }];
    const client = fakeClient(withWireframe);
    await expect(
      resolveGameUiScreenPlan(client, client, {
        screenId: SCREEN_ID,
        expectedRevision: 3,
        model: "openai/gpt-image-2",
        size: "1024x1024",
        quality: "low",
        count: 1,
        referenceIds: [REF_A],
        costMode: "strict_1000",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SETTINGS" });
  });

  it("refuses a reference from another workspace or another domain", async () => {
    const foreign = tables();
    foreign.style_references = [
      { id: REF_A, style_id: STYLE_ID, content_hash: "a".repeat(64), retired_at: null, styles: { id: STYLE_ID, workspace_id: "11111111-1111-4111-8111-111111111111", library_id: null, domain: "game_ui" } },
      { id: REF_B, style_id: "88888888-8888-4888-8888-888888888888", content_hash: "b".repeat(64), retired_at: null, styles: { id: "88888888-8888-4888-8888-888888888888", workspace_id: "22222222-2222-4222-8222-222222222222", library_id: null, domain: "game_ui" } },
    ];
    const client = fakeClient(foreign);
    await expect(
      resolveGameUiScreenPlan(client, client, {
        screenId: SCREEN_ID,
        expectedRevision: 3,
        model: "openai/gpt-image-2",
        size: "1024x1024",
        quality: "low",
        count: 1,
        referenceIds: [REF_B],
        costMode: "strict_1000",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
  });

  it("pins a reconstruction to the render's own revision and set revision", async () => {
    const client = fakeClient(tables());
    const result = await resolveGameUiReconstructionPlan(client, client, {
      renderId: RENDER_ID,
      elementSetId: SET_ID,
      elementId: ELEMENT_ID,
      instruction: "repaint the button",
      model: "openai/gpt-image-2",
      size: "auto",
      quality: "low",
      costMode: "strict_1000",
      requestId: REQUEST_ID,
    });
    expect(result.packet.intent).toBe("element_reconstruction");
    expect(result.packet.background).toBe("transparent");
    expect(result.packet.style_revision).toBe(revision);
    expect(result.packet.source_version_id).toBe(RENDER_VERSION_ID);
    expect(result.packet.context).toMatchObject({ render_id: RENDER_ID, element_set_id: SET_ID, element_id: ELEMENT_ID, source_content_hash: "d".repeat(64) });
    expect(result.plan.operation).toBe("image_to_image");
  });

  it("refuses to reconstruct an element that is not in the newest saved map", async () => {
    const stale = tables();
    stale.game_ui_element_sets = [
      { id: SET_ID, render_id: RENDER_ID, revision: 1, document },
      { id: "12121212-1111-4111-8111-111111111111", render_id: RENDER_ID, revision: 2, document },
    ];
    const client = fakeClient(stale);
    await expect(
      resolveGameUiReconstructionPlan(client, client, {
        renderId: RENDER_ID,
        elementSetId: SET_ID,
        elementId: ELEMENT_ID,
        instruction: "repaint",
        model: "openai/gpt-image-2",
        size: "auto",
        quality: "low",
        costMode: "strict_1000",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "SCREEN_VERSION_CONFLICT" });
  });

  it("refuses an element missing from the map and a group element", async () => {
    const withoutElement = tables();
    withoutElement.game_ui_element_sets = [{ id: SET_ID, render_id: RENDER_ID, revision: 2, document: { ...document, elements: [] } }];
    await expect(
      resolveGameUiReconstructionPlan(fakeClient(withoutElement), fakeClient(withoutElement), {
        renderId: RENDER_ID,
        elementSetId: SET_ID,
        elementId: ELEMENT_ID,
        instruction: "repaint",
        model: "openai/gpt-image-2",
        size: "auto",
        quality: "low",
        costMode: "strict_1000",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND" });

    const group = tables();
    group.game_ui_element_sets = [{ id: SET_ID, render_id: RENDER_ID, revision: 2, document: { ...document, elements: [{ ...element, kind: "group" }] } }];
    await expect(
      resolveGameUiReconstructionPlan(fakeClient(group), fakeClient(group), {
        renderId: RENDER_ID,
        elementSetId: SET_ID,
        elementId: ELEMENT_ID,
        instruction: "repaint",
        model: "openai/gpt-image-2",
        size: "auto",
        quality: "low",
        costMode: "strict_1000",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("refuses a prompt that would need more than the provider accepts", () => {
    const manyRequirements = Array.from({ length: 60 }, (_unused, index) => ({
      id: `${String(index).padStart(8, "0")}-dddd-4ddd-8ddd-444444444444`,
      kind: "button" as const,
      custom_type: null,
      name: `Element ${index}`,
      purpose: "p".repeat(100),
      visible_text: "v".repeat(60),
      visible_state: null,
      required: true,
    }));
    expect(() =>
      compileGameUiPacket({
        intent: "screen",
        styleId: STYLE_ID,
        styleRevision: revision,
        schema: styleSchema as never,
        spec: { ...spec, requirements: manyRequirements } as never,
        screenId: SCREEN_ID,
        draftRevision: 1,
        wireframeInputId: null,
        sourceVersionId: null,
        sourceContentHash: null,
        references: [{ id: REF_A, content_hash: "a".repeat(64) }],
        operation: "text_to_image",
        model: "openai/gpt-image-2",
        size: "1024x1024",
        quality: "low",
        count: 1,
        requestId: REQUEST_ID,
      }),
    ).toThrowError(GameUiError);
  });
});
