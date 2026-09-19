// @vitest-environment node
// Game UI jobs through the real worker: the element crop, the source hash the
// packet recorded, and the transparency a reconstructed element must have.  The
// images are real PNGs decoded by sharp, so the assertions are about pixels.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processAiJob } from "../src/lib/ai/worker";

const mockSubmit = vi.fn();
const mockProviderForJob = vi.fn();
const mockGetProviderApiKey = vi.fn();
const mockGetOwnedAssetVersion = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetOwnedJobReference = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockDownloadOwnedBytes = vi.fn();
/** The branded object the ownership helpers hand back; its path identifies the
 * download, which is how this file tells the source from the reference. */
type Owned = { path: "source" | "reference" };

vi.mock("@/lib/ai/providers", () => ({ get providerForJob() { return mockProviderForJob; } }));
vi.mock("@/lib/ai/credentials", () => ({ get getProviderApiKey() { return mockGetProviderApiKey; } }));
vi.mock("@/lib/assets/service", () => ({
  prepareImageBytes: vi.fn(async (bytes: Uint8Array) => ({ bytes, mimeType: "image/png", extension: "png", width: 512, height: 512 })),
}));
vi.mock("@/lib/assets/ownership", () => ({
  getOwnedAssetVersion: (...args: unknown[]) => mockGetOwnedAssetVersion(...args),
  downloadOwnedBytes: (...args: unknown[]) => mockDownloadOwnedBytes(...args),
  getOwnedJobReference: (...args: unknown[]) => mockGetOwnedJobReference(...args),
  getOwnedJobMask: vi.fn(),
  removeOwnedObjects: vi.fn(async () => undefined),
  ownedStorageObjectFromPath: vi.fn(),
}));

const mockRpc = vi.fn();
const mockUpload = vi.fn();
const mockRemove = vi.fn();
function supabaseClient() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data: { asset_id: "99999999-9999-4999-8999-999999999999" }, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data: { name: "Arcane HUD" }, error: null }));
  chain.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onFulfilled);
  return {
    rpc: mockRpc,
    storage: { from: vi.fn(() => ({ upload: mockUpload, remove: mockRemove })) },
    from: vi.fn(() => chain),
  } as never;
}

const WORKER_ID = "worker-1";
const WS_ID = "11111111-1111-4111-8111-111111111111";
const STYLE_ID = "66666666-6666-4666-8666-666666666666";
const REFERENCE_ID = "77777777-7777-4777-8777-777777777777";
const RENDER_VERSION_ID = "88888888-8888-4888-8888-888888888888";
const ELEMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const REQUEST_ID = "bbbbbbbb-1111-4111-8111-111111111111";

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

const element = {
  id: ELEMENT_ID,
  parent_id: null,
  kind: "button" as const,
  custom_type: null,
  name: "Continue",
  purpose: "",
  visible_text: "Continue",
  visible_state: null,
  bounds: { x: 6, y: 4, width: 12, height: 8 },
  z_index: 0,
  occluded: false,
  confidence: null,
  notes: "",
  reviewed: true,
};

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The reference image every packet in this file records. */
let referencePng: Buffer;

function referenceHash(): string {
  return hash(new Uint8Array(referencePng));
}

/** A 40x30 opaque screen with a recognisable pattern. */
async function screenPng(): Promise<Buffer> {
  const pixels = Buffer.alloc(40 * 30 * 4);
  for (let index = 0; index < 40 * 30; index += 1) {
    pixels[index * 4] = (index * 7) % 256;
    pixels[index * 4 + 1] = (index * 11) % 256;
    pixels[index * 4 + 2] = (index * 13) % 256;
    pixels[index * 4 + 3] = 255;
  }
  return sharp(pixels, { raw: { width: 40, height: 30, channels: 4 } }).png().toBuffer();
}

async function transparentPng(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const visible = index % 2 === 0;
    pixels[index * 4] = 200;
    pixels[index * 4 + 1] = 100;
    pixels[index * 4 + 2] = 50;
    pixels[index * 4 + 3] = visible ? 255 : 0;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function opaquePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
}

function screenPacket(sourceHash: string | null) {
  return {
    packet_version: 2,
    domain: "game_ui",
    style_id: STYLE_ID,
    style_revision: "cccccccc-1111-4111-8111-111111111111",
    schema_snapshot: styleSchema,
    operation: sourceHash ? "image_to_image" : "text_to_image",
    original_prompt: "Battle HUD",
    compiled_prompt: "STYLE ... SCREEN ...",
    reference_snapshot: [{ id: REFERENCE_ID, content_hash: referenceHash() }],
    source_version_id: sourceHash ? RENDER_VERSION_ID : null,
    model: "openai/gpt-image-2",
    size: "1024x1024",
    quality: "low",
    count: 1,
    intent: "screen",
    context: {
      screen_id: "dddddddd-1111-4111-8111-111111111111",
      draft_revision: 1,
      spec_snapshot: { schema_version: 1, name: "Battle HUD", description: "", layout_notes: "", requirements: [] },
      wireframe_input_id: null,
      source_content_hash: sourceHash,
      request_id: REQUEST_ID,
    },
  };
}

function reconstructionPacket(sourceHash: string) {
  return {
    ...screenPacket(sourceHash),
    operation: "image_to_image",
    original_prompt: "reconstruct the continue button",
    background: "transparent",
    intent: "element_reconstruction",
    source_version_id: RENDER_VERSION_ID,
    context: {
      screen_id: "dddddddd-1111-4111-8111-111111111111",
      render_id: "eeeeeeee-1111-4111-8111-111111111111",
      element_set_id: "ffffffff-1111-4111-8111-111111111111",
      element_id: ELEMENT_ID,
      element_snapshot: element,
      source_content_hash: sourceHash,
      request_id: REQUEST_ID,
    },
  };
}

function makeJob(packet: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: WS_ID,
    project_id: null,
    module: "style",
    style_id: STYLE_ID,
    requested_by: "44444444-4444-4444-8444-444444444444",
    asset_id: "99999999-9999-4999-8999-999999999999",
    parent_version_id: RENDER_VERSION_ID,
    source_version_id: packet.source_version_id,
    version_id: null,
    operation: packet.operation,
    provider: "openai",
    model: "openai/gpt-image-2",
    status: "queued",
    attempt_count: 0,
    lease_owner: WORKER_ID,
    lease_expires_at: null,
    provider_request_id: null,
    provider_status: null,
    input: {
      prompt: "Battle HUD",
      count: 1,
      size: "1024x1024",
      quality: "low",
      style_id: STYLE_ID,
      source_version_id: packet.source_version_id,
      reference_ids: [REFERENCE_ID],
      ...(packet.background ? { background: "transparent" } : {}),
    },
    style_generation: packet,
    output: {},
    error_code: null,
    error_message: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function completedWith(bytes: Buffer) {
  return { state: "completed", images: [{ kind: "bytes", bytes: new Uint8Array(bytes), contentType: "image/png" }], requestId: null, metadata: {} };
}

beforeEach(async () => {
  vi.clearAllMocks();
  referencePng = await opaquePng(4, 4);
  mockProviderForJob.mockResolvedValue({ submit: mockSubmit, poll: vi.fn(), cancel: vi.fn() });
  mockGetProviderApiKey.mockResolvedValue("test-key");
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockUpload.mockResolvedValue({ error: null });
  mockRemove.mockResolvedValue({ error: null });
  mockGetOwnedJobReference.mockResolvedValue({
    owned: { workspaceId: WS_ID, path: "reference" },
    reference: { id: REFERENCE_ID, style_id: STYLE_ID, storage_path: "p", mime_type: "image/png", byte_size: 1, width: 4, height: 4, content_hash: referenceHash(), created_at: "2026-01-01T00:00:00.000Z" },
    style: { id: STYLE_ID, workspace_id: WS_ID },
  });
  // Signature is (client, brandedOwned): the branded object is the second argument.
  mockDownloadOwnedBytes.mockImplementation(async (_client: unknown, owned: Owned) =>
    owned.path === "reference"
      ? { bytes: new Uint8Array(referencePng), mimeType: "image/png" }
      : { bytes: new Uint8Array(await screenPng()), mimeType: "image/png" },
  );
  mockGetOwnedAssetVersion.mockResolvedValue({
    owned: { workspaceId: WS_ID, path: "source" },
    asset: { id: "99999999-9999-4999-8999-999999999999", project_id: null, style_id: STYLE_ID },
    version: { id: RENDER_VERSION_ID, asset_id: "99999999-9999-4999-8999-999999999999", storage_path: "p", mime_type: "image/png", width: 40, height: 30, byte_size: 1, source: "web_openai", parent_version_id: null, prompt: null, metadata: {} },
  });
});

describe("game ui jobs in the worker", () => {
  it("records the hash of the final bytes when a screen render completes", async () => {
    const screen = await screenPng();
    mockSubmit.mockResolvedValue(completedWith(screen));
    const packet = screenPacket(null);
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(packet), WORKER_ID);
    expect(result).toBe("succeeded");
    const completion = mockRpc.mock.calls.find((call) => call[0] === "complete_ai_job_with_results");
    expect(completion).toBeTruthy();
    const results = (completion![1] as { p_results: Array<{ metadata: Record<string, unknown> }> }).p_results;
    expect(results[0].metadata.content_hash).toBe(hash(screen));
  });

  it("crops the element box and requires transparency for a reconstruction", async () => {
    const screen = await screenPng();
    const sourceHash = hash(screen);
    const elementPng = await transparentPng(element.bounds.width, element.bounds.height);
    mockSubmit.mockResolvedValue(completedWith(elementPng));
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(reconstructionPacket(sourceHash)), WORKER_ID);
    expect(result).toBe("succeeded");
    const submitted = mockSubmit.mock.calls[0][0] as { inputImages: Array<{ role: string; bytes: Uint8Array }>; job: { input: { background?: string } } };
    const source = submitted.inputImages.find((image) => image.role === "source")!;
    const metadata = await sharp(Buffer.from(source.bytes)).metadata();
    // The provider sees exactly the element, not the whole screen.
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: element.bounds.width, height: element.bounds.height });
    expect(submitted.job.input.background).toBe("transparent");
    const completion = mockRpc.mock.calls.find((call) => call[0] === "complete_ai_job_with_results");
    const results = (completion![1] as { p_results: Array<{ metadata: Record<string, unknown> }> }).p_results;
    expect(results[0].metadata.alpha_status).toBe("transparent");
    expect(results[0].metadata.content_hash).toBe(hash(elementPng));
  });

  it("refuses a source that no longer matches the recorded hash", async () => {
    const screen = await screenPng();
    mockSubmit.mockResolvedValue(completedWith(await transparentPng(4, 4)));
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(reconstructionPacket("b".repeat(64))), WORKER_ID);
    expect(result).toBe("failed");
    expect(mockSubmit).not.toHaveBeenCalled();
    const failure = mockRpc.mock.calls.find((call) => call[0] === "fail_ai_job");
    expect((failure![1] as { p_error_code: string }).p_error_code).toBe("SOURCE_CONTENT_CHANGED");
  });

  it("fails a reconstruction that comes back opaque instead of storing it", async () => {
    const screen = await screenPng();
    mockSubmit.mockResolvedValue(completedWith(await opaquePng(element.bounds.width, element.bounds.height)));
    const client = supabaseClient();
    const result = await processAiJob(client, makeJob(reconstructionPacket(hash(screen))), WORKER_ID);
    expect(result).toBe("failed");
    const failure = mockRpc.mock.calls.find((call) => call[0] === "fail_ai_job");
    expect((failure![1] as { p_error_code: string }).p_error_code).toBe("TRANSPARENCY_REQUIRED");
    // Nothing was uploaded, so no opaque PNG can become an accepted asset.
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.some((call) => call[0] === "complete_ai_job_with_results")).toBe(false);
  });
});
