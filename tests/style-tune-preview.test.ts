// @vitest-environment node
// The tune preview is a read-only endpoint: it must show the prompt a change would
// compile to, refuse a style that was never confirmed, and write nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/env", () => ({
  getEnv: () => ({ STYLE_PROFILES_ENABLED: true }),
}));
vi.mock("../src/supabase/server", () => ({
  createClient: vi.fn(() => client),
}));

import { createEmptyPrompt } from "../src/lib/style/prompt-schema";
import { POST as previewTune } from "../src/app/api/styles/[styleId]/tune/preview/route";

function builder(final: unknown, overrides: Record<string, unknown> = {}) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order", "insert", "update", "delete"]) {
    node[method] = vi.fn(() => node);
  }
  node.single = vi.fn(async () => final);
  node.maybeSingle = vi.fn(async () => final);
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(final).then(onFulfilled);
  return Object.assign(node, overrides);
}

let client: Record<string, unknown>;
let styles: Record<string, unknown>;

const reference = { id: crypto.randomUUID(), content_hash: "a".repeat(64) };
const styleRevision = crypto.randomUUID();

/** A confirmed definition is the authority the preview compiles against. */
function confirmedDefinition() {
  return {
    definition_version: 1,
    style_revision: styleRevision,
    schema_snapshot: createEmptyPrompt(),
    reference_snapshot: [reference],
    confirmed_at: "2026-09-16T10:00:00.000Z",
  };
}

/** The mutable candidate the preview patches; the schema is strict, so it is complete. */
function candidateSchema() {
  const schema = createEmptyPrompt();
  schema.lighting.light_color_temperature = "neutral";
  return schema;
}

function preview(body: unknown) {
  return previewTune(new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ styleId: "s1" }),
  });
}

const change = { group: "lighting", field: "light_color_temperature", suggested_value: "warm" };

beforeEach(() => {
  vi.clearAllMocks();
  styles = builder({ data: { schema: candidateSchema(), confirmed_definition: confirmedDefinition() }, error: null });
  client = {
    auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "user-1" } }, error: null })) },
    from: vi.fn(() => styles),
  };
});

describe("POST /api/styles/[styleId]/tune/preview", () => {
  it("applies changes to a copy and compiles the prompt it would send", async () => {
    const response = await preview({ changes: [change] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.compiledPromptAfter).not.toBe(body.compiledPromptBefore);
    expect(body.compiledPromptAfter).toContain("warm");
    expect(body.compiledPromptBefore).toContain("neutral");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.quality).toBeTruthy();
    expect(body.operability).toBeTruthy();
    // The route's contract is that a preview writes nothing.
    expect(styles.update).not.toHaveBeenCalled();
    expect(styles.insert).not.toHaveBeenCalled();
  });

  it("refuses a style that was never confirmed", async () => {
    styles = builder({ data: { schema: candidateSchema(), confirmed_definition: null }, error: null });
    const response = await preview({ changes: [change] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_REQUEST", message: "STYLE_SOURCE_SNAPSHOT_REQUIRED" } });
  });

  it("refuses an empty or unknown change set", async () => {
    const empty = await preview({ changes: [] });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe("INVALID_REQUEST");

    const extra = await preview({ changes: [{ ...change, unexpected: true }] });
    expect(extra.status).toBe(400);
    expect((await extra.json()).error.code).toBe("INVALID_REQUEST");
  });
});
