// @vitest-environment jsdom
// Route-level proof for the Game UI asset endpoints: refusals happen before any
// byte is stored, an explicit output id makes extraction idempotent, and an
// export hands the browser a pinned manifest that leaks no storage location.
//
// The database is a small in-memory fake: the routes read through PostgREST
// builders, so the fake answers the same terminal shapes and the RPC mocks
// insert the rows the real functions insert.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sharp from "sharp";

vi.mock("@/supabase/server", () => ({
  createClient: vi.fn(async () => client),
  getServiceClient: vi.fn(() => service),
}));

import { POST as uploadWireframe } from "@/app/api/game-ui/styles/[styleId]/wireframes/route";
import { POST as uploadMatte } from "@/app/api/game-ui/renders/[renderId]/elements/[elementId]/matte/route";
import { POST as extractElementRoute } from "@/app/api/game-ui/renders/[renderId]/elements/[elementId]/extract/route";
import { PATCH as reviewOutput } from "@/app/api/game-ui/outputs/[outputId]/route";
import { POST as exportPack } from "@/app/api/game-ui/renders/[renderId]/export/route";
import { packEntryPath } from "@/lib/game-ui/manifest";

const WS = "0f0f0f0f-0000-4000-8000-000000000001";
const STYLE_ID = "11111111-1111-4111-8111-111111111111";
const RENDER_ID = "22222222-2222-4222-8222-222222222222";
const RENDER_ASSET = "33333333-3333-4333-8333-333333333333";
const RENDER_VERSION = "44444444-4444-4444-8444-444444444444";
const STALE_SET_ID = "55555555-5555-4555-8555-555555555550";
const SET_ID = "55555555-5555-4555-8555-555555555555";
const ELEMENT_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_ELEMENT_ID = "66666666-6666-4666-8666-666666666667";
const GROUP_ID = "77777777-7777-4777-8777-777777777777";
const MATTE_INPUT_ID = "88888888-8888-4888-8888-888888888888";
const MATTE_ASSET = "99999999-9999-4999-8999-999999999999";
const MATTE_VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTPUT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTPUT_ASSET = "cccccccc-ccc4-4ccc-8ccc-cccccccccccc";
const OUTPUT_VERSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECOND_OUTPUT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SECOND_OUTPUT_ASSET = "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0";
const SECOND_OUTPUT_VERSION = "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1";
const UNKNOWN_RENDER_ID = "00000000-0000-4000-8000-00000000000f";
const REQUEST_SET_ID = "12121212-1212-4212-8212-121212121212";

const RENDER_VERSION_PATH = `${WS}/styles/${STYLE_ID}/outputs/${RENDER_ASSET}/${RENDER_VERSION}/source.png`;
const MATTE_VERSION_PATH = `${WS}/styles/${STYLE_ID}/sources/${MATTE_ASSET}/${MATTE_VERSION}/source.png`;
const OUTPUT_VERSION_PATH = `${WS}/styles/${STYLE_ID}/outputs/${OUTPUT_ASSET}/${OUTPUT_VERSION}/source.png`;
const SECOND_OUTPUT_VERSION_PATH = `${WS}/styles/${STYLE_ID}/outputs/${SECOND_OUTPUT_ASSET}/${SECOND_OUTPUT_VERSION}/source.png`;

const RENDER_HASH = "1".repeat(64);
const MATTE_HASH = "2".repeat(64);
const OUTPUT_HASH = "3".repeat(64);
const SECOND_OUTPUT_HASH = "4".repeat(64);

const CANVAS = { width: 8, height: 8 };

type Row = Record<string, unknown>;

/** Minimal PostgREST fake: filters, ordering and the two terminal shapes. */
function queryBuilder(source: Row[]) {
  let rows = [...source];
  const compare = (left: unknown, right: unknown) => (left === right ? 0 : String(left) < String(right) ? -1 : 1);
  const node = {
    select: () => node,
    eq: (column: string, value: unknown) => {
      rows = rows.filter((row) => row[column] === value);
      return node;
    },
    in: (column: string, values: readonly unknown[]) => {
      rows = rows.filter((row) => values.includes(row[column]));
      return node;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      const direction = options?.ascending === false ? -1 : 1;
      rows = [...rows].sort((left, right) => compare(left[column], right[column]) * direction);
      return node;
    },
    limit: (count: number) => {
      rows = rows.slice(0, count);
      return node;
    },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    single: async () => (rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "PGRST116" } }),
    then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(onFulfilled),
  };
  return node;
}

/** RPC results keep both await shapes: awaited directly, or unwrapped by .single(). */
function rpcNode(result: { data: unknown; error: unknown }) {
  return {
    single: async () => result,
    then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(result).then(onFulfilled),
  };
}

function element(overrides: Partial<Row> & { id: string; kind: string; bounds: Row }): Row {
  return {
    parent_id: null,
    custom_type: null,
    name: "Pause button",
    purpose: "Pause the battle",
    visible_text: null,
    visible_state: null,
    z_index: 0,
    occluded: false,
    confidence: null,
    notes: "",
    reviewed: true,
    ...overrides,
  };
}

function elementDocument(overrides: Row = {}): Row {
  return {
    schema_version: 1,
    render_id: RENDER_ID,
    source_version_id: RENDER_VERSION,
    canvas: { ...CANVAS },
    elements: [element({ id: ELEMENT_ID, kind: "button", bounds: { x: 0, y: 0, width: 8, height: 8 } })],
    coverage: [],
    ...overrides,
  };
}

function outputRow(overrides: Row = {}): Row {
  return {
    id: OUTPUT_ID,
    workspace_id: WS,
    render_id: RENDER_ID,
    element_set_id: SET_ID,
    element_id: ELEMENT_ID,
    mode: "exact",
    matte_input_id: MATTE_INPUT_ID,
    job_id: null,
    asset_id: OUTPUT_ASSET,
    version_id: OUTPUT_VERSION,
    alpha_status: "transparent",
    review_status: "accepted",
    source_bounds: { x: 0, y: 0, width: 8, height: 8 },
    provider: null,
    model: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type Tables = Record<string, Row[]>;

/** The database as the migrations leave it after one generated and extracted screen. */
function seed(): Tables {
  return {
    styles: [{ id: STYLE_ID, workspace_id: WS, status: "active", domain: "game_ui", library_id: null, confirmed_definition: {} }],
    game_ui_renders: [
      {
        id: RENDER_ID,
        workspace_id: WS,
        style_id: STYLE_ID,
        screen_id: "abababab-abab-4bab-8bab-abababababab",
        job_id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        asset_id: RENDER_ASSET,
        version_id: RENDER_VERSION,
        spec_snapshot: { schema_version: 1, name: "Battle HUD", description: "", layout_notes: "", requirements: [] },
        style_revision: "efefefef-efef-4fef-8fef-efefefefefef",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    game_ui_element_sets: [
      { id: STALE_SET_ID, workspace_id: WS, render_id: RENDER_ID, revision: 1, document: elementDocument(), created_at: "2026-01-01T00:00:00.000Z" },
      {
        id: SET_ID,
        workspace_id: WS,
        render_id: RENDER_ID,
        revision: 2,
        document: elementDocument({
          elements: [
            element({ id: ELEMENT_ID, kind: "button", name: "Pause button", bounds: { x: 0, y: 0, width: 6, height: 6 } }),
            element({ id: OTHER_ELEMENT_ID, kind: "icon", name: "Coin icon", bounds: { x: 2, y: 2, width: 6, height: 6 } }),
          ],
          coverage: [{ requirement_id: "abababab-abab-4bab-8bab-abababababab", element_ids: [ELEMENT_ID], status: "present", note: "" }],
        }),
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ],
    game_ui_inputs: [
      {
        id: MATTE_INPUT_ID,
        workspace_id: WS,
        style_id: STYLE_ID,
        version_id: MATTE_VERSION,
        kind: "element_matte",
        content_hash: MATTE_HASH,
        render_id: RENDER_ID,
        element_set_id: SET_ID,
        element_id: ELEMENT_ID,
        width: 6,
        height: 6,
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ],
    game_ui_element_outputs: [
      outputRow(),
      outputRow({ id: SECOND_OUTPUT_ID, element_id: OTHER_ELEMENT_ID, asset_id: SECOND_OUTPUT_ASSET, version_id: SECOND_OUTPUT_VERSION, source_bounds: { x: 2, y: 2, width: 6, height: 6 } }),
    ],
    assets: [
      { id: RENDER_ASSET, project_id: null, style_id: STYLE_ID, current_version_id: RENDER_VERSION },
      { id: MATTE_ASSET, project_id: null, style_id: STYLE_ID, current_version_id: MATTE_VERSION },
      { id: OUTPUT_ASSET, project_id: null, style_id: STYLE_ID, current_version_id: OUTPUT_VERSION },
      { id: SECOND_OUTPUT_ASSET, project_id: null, style_id: STYLE_ID, current_version_id: SECOND_OUTPUT_VERSION },
    ],
    asset_versions: [
      {
        id: RENDER_VERSION,
        asset_id: RENDER_ASSET,
        storage_path: RENDER_VERSION_PATH,
        mime_type: "image/png",
        width: CANVAS.width,
        height: CANVAS.height,
        byte_size: 400,
        source: "extraction",
        parent_version_id: null,
        prompt: null,
        metadata: { content_hash: RENDER_HASH },
      },
      {
        id: MATTE_VERSION,
        asset_id: MATTE_ASSET,
        storage_path: MATTE_VERSION_PATH,
        mime_type: "image/png",
        width: CANVAS.width,
        height: CANVAS.height,
        byte_size: 120,
        source: "upload",
        parent_version_id: null,
        prompt: null,
        metadata: { content_hash: MATTE_HASH },
      },
      {
        id: OUTPUT_VERSION,
        asset_id: OUTPUT_ASSET,
        storage_path: OUTPUT_VERSION_PATH,
        mime_type: "image/png",
        width: 6,
        height: 6,
        byte_size: 210,
        source: "extraction",
        parent_version_id: null,
        prompt: null,
        metadata: { content_hash: OUTPUT_HASH, matte_hash: MATTE_HASH, mode: "exact" },
      },
      {
        id: SECOND_OUTPUT_VERSION,
        asset_id: SECOND_OUTPUT_ASSET,
        storage_path: SECOND_OUTPUT_VERSION_PATH,
        mime_type: "image/png",
        width: 6,
        height: 6,
        byte_size: 220,
        source: "extraction",
        parent_version_id: null,
        prompt: null,
        metadata: { content_hash: SECOND_OUTPUT_HASH, matte_hash: MATTE_HASH, mode: "exact" },
      },
    ],
  };
}

let tables: Tables;
let client: Record<string, unknown>;
let service: Record<string, unknown>;
let uploads: Array<{ path: string; bytes: Uint8Array }>;
let removals: string[];
let signed: Array<{ path: string; ttl: number }>;
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
let downloads: Record<string, Uint8Array>;
let claims: unknown;
/** The service-role RPC mock, kept typed so a test can override one answer. */
let serviceRpc: Mock;
/** The member-session RPC mock: the review route goes through RLS, not service role. */
let clientRpc: Mock;

function blobOf(bytes: Uint8Array) {
  return { arrayBuffer: async () => bytes.slice().buffer };
}

function buildService(): Record<string, unknown> {
  // Synchronous on purpose: a route chains `.single()` on the call, which an
  // async mock would break. The returned node is thenable for direct awaits.
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "register_game_ui_input") {
      const file = args.p_file as Record<string, unknown>;
      tables.assets.push({ id: args.p_asset_id, project_id: null, style_id: args.p_style_id, current_version_id: args.p_version_id });
      tables.asset_versions.push({
        id: args.p_version_id,
        asset_id: args.p_asset_id,
        storage_path: file.storage_path,
        mime_type: file.mime_type,
        width: file.width,
        height: file.height,
        byte_size: file.byte_size,
        source: "upload",
        parent_version_id: null,
        prompt: null,
        metadata: { content_hash: file.content_hash, role: "game_ui_input", input_kind: args.p_kind },
      });
      const context = (args.p_context ?? {}) as Record<string, unknown>;
      const input = {
        id: args.p_input_id,
        workspace_id: args.p_workspace_id,
        style_id: args.p_style_id,
        version_id: args.p_version_id,
        kind: args.p_kind,
        content_hash: file.content_hash,
        render_id: context.render_id ?? null,
        element_set_id: context.element_set_id ?? null,
        element_id: context.element_id ?? null,
        width: file.width,
        height: file.height,
      };
      tables.game_ui_inputs.push(input);
      return rpcNode({ data: input, error: null });
    }
    if (name === "commit_game_ui_extraction") {
      const file = args.p_file as Record<string, unknown>;
      tables.assets.push({ id: args.p_asset_id, project_id: null, style_id: STYLE_ID, current_version_id: args.p_version_id });
      tables.asset_versions.push({
        id: args.p_version_id,
        asset_id: args.p_asset_id,
        storage_path: file.storage_path,
        mime_type: file.mime_type,
        width: file.width,
        height: file.height,
        byte_size: file.byte_size,
        source: "extraction",
        parent_version_id: null,
        prompt: null,
        metadata: { content_hash: file.content_hash, matte_hash: MATTE_HASH, mode: "exact" },
      });
      const output = outputRow({
        id: args.p_output_id,
        element_set_id: args.p_element_set_id,
        element_id: args.p_element_id,
        matte_input_id: args.p_matte_input_id,
        asset_id: args.p_asset_id,
        version_id: args.p_version_id,
        alpha_status: file.alpha_status,
        review_status: "pending",
      });
      tables.game_ui_element_outputs.push(output);
      return rpcNode({ data: output, error: null });
    }
    return rpcNode({ data: null, error: null });
  });
  serviceRpc = rpc;

  return {
    rpc,
    from: vi.fn((table: string) => queryBuilder(tables[table] ?? [])),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async (path: string, bytes: Uint8Array) => {
          uploads.push({ path, bytes });
          downloads[path] = bytes;
          return { data: { path }, error: null };
        }),
        remove: vi.fn(async (paths: string[]) => {
          removals.push(...paths);
          return { data: null, error: null };
        }),
        download: vi.fn(async (path: string) => {
          const bytes = downloads[path];
          return bytes ? { data: blobOf(bytes), error: null } : { data: null, error: { message: "Object not found" } };
        }),
        createSignedUrl: vi.fn(async (path: string, ttl: number) => {
          signed.push({ path, ttl });
          return { data: { signedUrl: `https://signed.local/${path}?token=test` }, error: null };
        }),
      })),
    },
  };
}

function buildClient(): Record<string, unknown> {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name !== "review_game_ui_output") return rpcNode({ data: null, error: { message: "NOT_FOUND" } });
    const row = tables.game_ui_element_outputs.find((candidate) => candidate.id === args.p_output_id);
    if (!row) return rpcNode({ data: null, error: { message: "OUTPUT_NOT_FOUND" } });
    if (row.review_status !== args.p_expected_status) return rpcNode({ data: null, error: { message: "SCREEN_VERSION_CONFLICT" } });
    if (args.p_status === "accepted" && row.alpha_status !== "transparent") {
      return rpcNode({ data: null, error: { message: "TRANSPARENCY_REQUIRED" } });
    }
    row.review_status = args.p_status;
    return rpcNode({ data: { ...row }, error: null });
  });
  clientRpc = rpc;
  return {
    auth: { getClaims: vi.fn(async () => ({ data: claims, error: null })) },
    from: vi.fn((table: string) => queryBuilder(tables[table] ?? [])),
    rpc,
  };
}

beforeEach(() => {
  tables = seed();
  uploads = [];
  removals = [];
  signed = [];
  rpcCalls = [];
  downloads = {};
  claims = { claims: { sub: "user-1" } };
  service = buildService();
  client = buildClient();
});

let sourcePng: Uint8Array;
let holedMattePng: Uint8Array;
let opaqueMattePng: Uint8Array;

beforeEach(async () => {
  const raw = Buffer.alloc(CANVAS.width * CANVAS.height * 4, 255);
  raw[3] = 0; // one removed pixel: the first pixel keeps alpha 0 in the matte
  sourcePng = new Uint8Array(await sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer());
  holedMattePng = new Uint8Array(await sharp(raw, { raw: { width: CANVAS.width, height: CANVAS.height, channels: 4 } }).png().toBuffer());
  opaqueMattePng = new Uint8Array(await sharp(Buffer.alloc(CANVAS.width * CANVAS.height * 4, 255), { raw: { width: CANVAS.width, height: CANVAS.height, channels: 4 } }).png().toBuffer());
});

function unauthenticated() {
  claims = null;
}

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * A real multipart body.  jsdom's `File` is not a Node `Blob`, so handing it to
 * undici's `Request` serialises "undefined"; assembling the body here keeps the
 * route's own `request.formData()` parsing under test.
 */
function formRequest(url: string, bytes: Uint8Array, fields: Record<string, string> = {}, mimeType = "image/png") {
  const boundary = "----game-ui-test-boundary";
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.png"\r\nContent-Type: ${mimeType}\r\n\r\n`));
  parts.push(bytes);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  return new Request(url, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
}

const commitCalls = () => rpcCalls.filter((call) => call.name === "commit_game_ui_extraction");
const renderedParams = (renderId = RENDER_ID) => ({ params: Promise.resolve({ renderId, elementId: ELEMENT_ID }) });

describe("POST /api/game-ui/styles/[styleId]/wireframes", () => {
  it("answers 401 without a verified user", async () => {
    unauthenticated();
    const response = await uploadWireframe(formRequest("http://localhost/wireframes", sourcePng), { params: Promise.resolve({ styleId: STYLE_ID }) });
    expect(response.status).toBe(401);
    expect(uploads).toHaveLength(0);
  });

  it("answers 404 for a style outside the caller's workspace", async () => {
    const response = await uploadWireframe(formRequest("http://localhost/wireframes", sourcePng), { params: Promise.resolve({ styleId: UNKNOWN_RENDER_ID }) });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
    expect(uploads).toHaveLength(0);
  });

  it("stores a wireframe under the derived source path and registers it", async () => {
    const response = await uploadWireframe(formRequest("http://localhost/wireframes", sourcePng), { params: Promise.resolve({ styleId: STYLE_ID }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.inputId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.width).toBe(CANVAS.width);
    expect(body.height).toBe(CANVAS.height);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe(`${WS}/styles/${STYLE_ID}/sources/${body.assetId}/${body.versionId}/source.png`);
    const register = rpcCalls.find((call) => call.name === "register_game_ui_input");
    expect(register?.args.p_kind).toBe("wireframe");
    expect(register?.args.p_context).toEqual({});
    expect(body.signedUrl).toContain("signed.local");
  });

  it("answers 415 when the declared type disagrees with the decoded bytes", async () => {
    const response = await uploadWireframe(formRequest("http://localhost/wireframes", sourcePng, {}, "image/jpeg"), { params: Promise.resolve({ styleId: STYLE_ID }) });
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("UNSUPPORTED_IMAGE_TYPE");
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("POST /api/game-ui/renders/[renderId]/elements/[elementId]/matte", () => {
  const matteRequest = (bytes: Uint8Array) => formRequest("http://localhost/matte", bytes, { elementSetId: SET_ID });

  it("answers 401 without a verified user", async () => {
    unauthenticated();
    const response = await uploadMatte(matteRequest(holedMattePng), renderedParams());
    expect(response.status).toBe(401);
  });

  it("answers 404 for a render outside the caller's workspace", async () => {
    const response = await uploadMatte(matteRequest(holedMattePng), renderedParams(UNKNOWN_RENDER_ID));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("RENDER_NOT_FOUND");
    expect(uploads).toHaveLength(0);
  });

  it("refuses a matte that does not match the element box before uploading", async () => {
    // The element box in the newest revision is 6x6; this matte is 8x8.
    const response = await uploadMatte(matteRequest(holedMattePng), renderedParams());
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(uploads).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a group element", async () => {
    tables.game_ui_element_sets = [
      {
        id: SET_ID,
        workspace_id: WS,
        render_id: RENDER_ID,
        revision: 1,
        document: elementDocument({ elements: [element({ id: GROUP_ID, kind: "group", bounds: { x: 0, y: 0, width: 6, height: 6 } })] }),
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const response = await uploadMatte(matteRequest(holedMattePng), { params: Promise.resolve({ renderId: RENDER_ID, elementId: GROUP_ID }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("group");
    expect(uploads).toHaveLength(0);
  });

  it("refuses an element set that is no longer the newest revision", async () => {
    // The revision is checked before geometry, so a stale map answers 409 even
    // though this matte would also have to be resized.
    const stale = await uploadMatte(formRequest("http://localhost/matte", holedMattePng, { elementSetId: STALE_SET_ID }), renderedParams());
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("SCREEN_VERSION_CONFLICT");
    expect(uploads).toHaveLength(0);
  });

  it("stores a matte sized to the element box and links it to the revision", async () => {
    tables.game_ui_element_sets[1].document = elementDocument({
      elements: [element({ id: ELEMENT_ID, kind: "button", bounds: { x: 0, y: 0, width: CANVAS.width, height: CANVAS.height } })],
    });
    const response = await uploadMatte(matteRequest(holedMattePng), renderedParams());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.inputId).toMatch(/^[0-9a-f-]{36}$/);
    const register = rpcCalls.find((call) => call.name === "register_game_ui_input");
    expect(register?.args.p_kind).toBe("element_matte");
    expect(register?.args.p_context).toEqual({ render_id: RENDER_ID, element_set_id: SET_ID, element_id: ELEMENT_ID });
    expect(uploads[0].path).toContain(`/styles/${STYLE_ID}/sources/`);
  });
});

describe("POST /api/game-ui/renders/[renderId]/elements/[elementId]/extract", () => {
  const extractRequest = (matteInputId = MATTE_INPUT_ID, outputId = OUTPUT_ID) =>
    jsonRequest("http://localhost/extract", { elementSetId: SET_ID, matteInputId, outputId });

  const extractionDocument = () => {
    tables.game_ui_element_sets[1].document = elementDocument({
      elements: [element({ id: ELEMENT_ID, kind: "button", bounds: { x: 0, y: 0, width: CANVAS.width, height: CANVAS.height } })],
    });
  };

  beforeEach(() => {
    tables.game_ui_element_outputs = [];
    downloads[RENDER_VERSION_PATH] = sourcePng;
    downloads[MATTE_VERSION_PATH] = holedMattePng;
    tables.game_ui_inputs[0].width = CANVAS.width;
    tables.game_ui_inputs[0].height = CANVAS.height;
  });

  it("answers 401 without a verified user", async () => {
    unauthenticated();
    const response = await extractElementRoute(extractRequest(), renderedParams());
    expect(response.status).toBe(401);
  });

  it("answers 422 and writes no output when the result is fully opaque", async () => {
    extractionDocument();
    downloads[MATTE_VERSION_PATH] = opaqueMattePng;
    const response = await extractElementRoute(extractRequest(), renderedParams());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("BACKGROUND_NOT_REMOVED");
    expect(commitCalls()).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(tables.game_ui_element_outputs).toHaveLength(0);
  });

  it("extracts exact pixels once and returns the existing output on a repeat", async () => {
    extractionDocument();
    const first = await extractElementRoute(extractRequest(), renderedParams());
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.output.id).toBe(OUTPUT_ID);
    expect(firstBody.output.alpha_status).toBe("transparent");
    expect(firstBody.output.review_status).toBe("pending");
    expect(commitCalls()).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe(`${WS}/styles/${STYLE_ID}/outputs/${commitCalls()[0].args.p_asset_id}/${commitCalls()[0].args.p_version_id}/source.png`);

    const repeat = await extractElementRoute(extractRequest(), renderedParams());
    expect(repeat.status).toBe(201);
    const repeatBody = await repeat.json();
    expect(repeatBody.output.id).toBe(OUTPUT_ID);
    expect(commitCalls()).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(tables.game_ui_element_outputs).toHaveLength(1);
  });

  it("refuses a matte that was painted for another element", async () => {
    extractionDocument();
    tables.game_ui_inputs[0].element_id = OTHER_ELEMENT_ID;
    const response = await extractElementRoute(extractRequest(), renderedParams());
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("INPUT_NOT_FOUND");
    expect(commitCalls()).toHaveLength(0);
  });
});

describe("PATCH /api/game-ui/outputs/[outputId]", () => {
  const reviewRequest = (status = "accepted", expectedReviewStatus = "pending", outputId = OUTPUT_ID) =>
    jsonRequest(`http://localhost/outputs/${outputId}`, { expectedReviewStatus, status }, "PATCH");
  const params = { params: Promise.resolve({ outputId: OUTPUT_ID }) };

  beforeEach(() => {
    tables.game_ui_element_outputs[0].review_status = "pending";
    tables.game_ui_element_outputs[0].alpha_status = "transparent";
  });

  it("answers 401 without a verified user", async () => {
    unauthenticated();
    const response = await reviewOutput(reviewRequest(), params);
    expect(response.status).toBe(401);
  });

  it("answers 404 when the RPC refuses an output the caller cannot see", async () => {
    const response = await reviewOutput(reviewRequest("accepted", "pending", REQUEST_SET_ID), {
      params: Promise.resolve({ outputId: REQUEST_SET_ID }),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("OUTPUT_NOT_FOUND");
    expect(clientRpc).toHaveBeenCalledWith("review_game_ui_output", expect.objectContaining({ p_output_id: REQUEST_SET_ID }));
  });

  it("passes a stale review status through as 409", async () => {
    tables.game_ui_element_outputs[0].review_status = "accepted";
    const response = await reviewOutput(reviewRequest("discarded", "pending"), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SCREEN_VERSION_CONFLICT");
  });

  it("refuses to accept an opaque output", async () => {
    tables.game_ui_element_outputs[0].alpha_status = "opaque";
    const response = await reviewOutput(reviewRequest(), params);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("TRANSPARENCY_REQUIRED");
    expect(tables.game_ui_element_outputs[0].review_status).toBe("pending");
  });

  it("accepts a pending transparent output", async () => {
    const response = await reviewOutput(reviewRequest(), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output.review_status).toBe("accepted");
    expect(tables.game_ui_element_outputs[0].review_status).toBe("accepted");
    expect(clientRpc).toHaveBeenCalledWith("review_game_ui_output", expect.objectContaining({ p_expected_status: "pending", p_status: "accepted" }));
  });

  it("rejects an unknown decision with 400", async () => {
    const response = await reviewOutput(jsonRequest("http://localhost", { expectedReviewStatus: "pending", status: "maybe" }, "PATCH"), params);
    expect(response.status).toBe(400);
    expect(clientRpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/game-ui/renders/[renderId]/export", () => {
  const exportRequest = (elementSetId = SET_ID, outputIds = [OUTPUT_ID, SECOND_OUTPUT_ID]) =>
    jsonRequest("http://localhost/export", { elementSetId, outputIds });
  const params = { params: Promise.resolve({ renderId: RENDER_ID }) };

  it("answers 401 without a verified user", async () => {
    unauthenticated();
    const response = await exportPack(exportRequest(), params);
    expect(response.status).toBe(401);
  });

  it("refuses a set that is no longer the newest revision", async () => {
    const response = await exportPack(exportRequest(STALE_SET_ID), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ASSET_PACK_NOT_READY");
    expect(signed).toHaveLength(0);
  });

  it("refuses an output that has not been accepted", async () => {
    tables.game_ui_element_outputs[0].review_status = "pending";
    const response = await exportPack(exportRequest(), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ASSET_PACK_NOT_READY");
    expect(signed).toHaveLength(0);
  });

  it("refuses an output that belongs to another element set revision", async () => {
    tables.game_ui_element_outputs[0].element_set_id = STALE_SET_ID;
    const response = await exportPack(exportRequest(), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ASSET_PACK_NOT_READY");
  });

  it("returns one file per selected output in the requested order and leaks nothing server-side", async () => {
    const response = await exportPack(exportRequest(SET_ID, [SECOND_OUTPUT_ID, OUTPUT_ID]), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.files.map((file: { outputId: string }) => file.outputId)).toEqual([SECOND_OUTPUT_ID, OUTPUT_ID]);
    expect(body.files).toHaveLength(2);
    expect(body.files[0].path).toBe(packEntryPath("Coin icon", OTHER_ELEMENT_ID));
    expect(body.files[0].sha256).toBe(SECOND_OUTPUT_HASH);
    expect(body.files[0].byteSize).toBe(220);
    expect(body.files[0].url).toContain("signed.local");
    expect(signed.map((entry) => entry.ttl)).toEqual([600, 600]);

    const manifest = JSON.stringify(body.manifest);
    expect(manifest).not.toContain(WS);
    expect(manifest).not.toContain("/styles/");
    expect(manifest).not.toContain("/outputs/");
    expect(manifest).not.toContain("signed.local");
    expect(manifest).not.toContain("token=");
    expect(manifest).toContain(OUTPUT_HASH);
    expect(body.manifest.assets.map((asset: { output_id: string }) => asset.output_id)).toEqual([SECOND_OUTPUT_ID, OUTPUT_ID]);
    expect(body.manifest.elements.map((row: { id: string }) => row.id)).toEqual([ELEMENT_ID, OTHER_ELEMENT_ID]);
    expect(body.manifest.element_set).toEqual({ id: SET_ID, revision: 2 });
    expect(body.manifest.screen.render_id).toBe(RENDER_ID);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses an output the caller does not own", async () => {
    const response = await exportPack(exportRequest(SET_ID, [REQUEST_SET_ID]), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ASSET_PACK_NOT_READY");
  });
});
