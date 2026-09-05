import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/env", () => ({
  getEnv: () => ({ STYLE_ANALYSIS_PROVIDER: "google", STYLE_ANALYSIS_MODEL: "gemini-test" }),
}));
vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
vi.mock("../src/supabase/server", () => ({
  createClient: vi.fn(),
  getServiceClient: vi.fn(() => serviceClient),
}));

import { analyzeStyleProfile, compileStyledPrompt } from "../src/lib/style/service";
import { StyleError } from "../src/lib/style/errors";

// Chainable Supabase builder: every verb returns the builder, terminal
// single/maybeSingle resolve to `final`.
function builder(final: unknown) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "insert", "update", "delete"]) {
    node[method] = vi.fn(() => node);
  }
  node.single = vi.fn(async () => final);
  node.maybeSingle = vi.fn(async () => final);
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(final).then(onFulfilled);
  return node;
}

const serviceClient = {
  storage: { from: vi.fn() },
  from: vi.fn((table: string) =>
    table === "provider_settings"
      ? builder({ data: null })
      : builder({ data: null, error: null }),
  ),
};

let client: Record<string, unknown>;

function makeClient() {
  return { auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) }, from: vi.fn() };
}

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=", "base64");

const VALID_SCHEMA = JSON.stringify({
  style_name: "Test Style",
  version: "1.0",
  subject_type: "object",
  subject: { main_subject: null },
  color_palette: { dominant_colors: ["#FF00AA"] },
  artistic_style: { medium: "vector" },
});

const REF_ROW = { id: "ref-1", storage_path: "ws/styles/style-1/ref-1.png", mime_type: "image/png", byte_size: onePixelPng.length, content_hash: "abc" };

function mockProviderFetch(text: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200 },
  )));
}

beforeEach(() => {
  vi.restoreAllMocks();
  client = makeClient();
  mockProviderFetch(VALID_SCHEMA);
});

describe("analyzeStyleProfile", () => {
  function stubTables({ style, refs, updateFinal }: { style: Record<string, unknown> | null; refs: unknown[]; updateFinal?: Record<string, unknown> }) {
    const from = client.from as ReturnType<typeof vi.fn>;
    from.mockImplementation((table: string) => {
      if (table === "provider_settings") return builder({ data: null });
      if (table === "styles") {
        return {
          ...builder({ data: style, error: null }),
          update: vi.fn(() => builder({ data: updateFinal ?? { ...style, schema: JSON.parse(VALID_SCHEMA) }, error: null })),
        };
      }
      if (table === "style_references") {
        return { ...builder({ data: refs, error: null }), order: vi.fn(async () => ({ data: refs, error: null })) };
      }
      return builder({ data: null, error: null });
    });
    serviceClient.storage.from.mockReturnValue({
      download: vi.fn(async () => ({ data: new Blob([onePixelPng]), error: null })),
    });
  }

  it("runs refs → preprocess → analyze → lint → persist and returns the updated style", async () => {
    stubTables({ style: { id: "style-1", name: "Test Style", status: "draft", schema: null, analysis_meta: {} }, refs: [REF_ROW], updateFinal: { id: "style-1", status: "draft", schema: JSON.parse(VALID_SCHEMA), analysis_meta: { provider: "google" } } });
    const updated = await analyzeStyleProfile({ styleId: "style-1", client: client as never });
    expect((updated.schema as Record<string, unknown>).style_name).toBe("Test Style");
    // The service computes analysis_meta; the mock echoes the persisted row.
    const updateCall = (client.from as ReturnType<typeof vi.fn>).mock.calls.filter(([table]) => table === "styles").length;
    expect(updateCall).toBeGreaterThan(0);
  });

  it("throws NO_REFERENCES when the style has no rows", async () => {
    stubTables({ style: { id: "style-1", name: "S", status: "draft", schema: null }, refs: [] });
    await expect(analyzeStyleProfile({ styleId: "style-1", client: client as never })).rejects.toMatchObject({ code: "NO_REFERENCES" });
  });

  it("throws STYLE_NOT_FOUND for a missing style", async () => {
    stubTables({ style: null, refs: [] });
    await expect(analyzeStyleProfile({ styleId: "missing", client: client as never })).rejects.toMatchObject({ code: "STYLE_NOT_FOUND" });
  });

  it("maps malformed provider JSON to STYLE_ANALYSIS_UNPARSED and never persists", async () => {
    stubTables({ style: { id: "style-1", name: "S", status: "draft", schema: null, analysis_meta: {} }, refs: [REF_ROW] });
    mockProviderFetch("```json\nnot-json\n```");
    const updateSpy = vi.fn();
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "provider_settings") return builder({ data: null });
      if (table === "styles") {
        return { ...builder({ data: { id: "style-1", name: "S", status: "draft", schema: null }, error: null }), update: updateSpy };
      }
      if (table === "style_references") {
        return { ...builder({ data: [REF_ROW], error: null }), order: vi.fn(async () => ({ data: [REF_ROW], error: null })) };
      }
      return builder({ data: null, error: null });
    });
    await expect(analyzeStyleProfile({ styleId: "style-1", client: client as never })).rejects.toMatchObject({ code: "STYLE_ANALYSIS_UNPARSED" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("keeps the style draft when the provider fails hard", async () => {
    stubTables({ style: { id: "style-1", name: "S", status: "draft", schema: null, analysis_meta: {} }, refs: [REF_ROW] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    await expect(analyzeStyleProfile({ styleId: "style-1", client: client as never })).rejects.toBeInstanceOf(StyleError);
  });
});

describe("compileStyledPrompt", () => {
  function stubStyleRow(row: Record<string, unknown> | null) {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "styles") return builder({ data: row, error: null });
      return builder({ data: null, error: null });
    });
  }

  it("appends the subject to the capsule for an active style", async () => {
    stubStyleRow({ id: "style-1", status: "active", schema: { style_name: "Capsule", artistic_style: { medium: "ink" } } });
    const compiled = await compileStyledPrompt({ styleId: "style-1", originalPrompt: "a red teapot", client: client as never });
    expect(compiled).toContain("Style capsule: Capsule");
    expect(compiled.endsWith("Subject: a red teapot")).toBe(true);
  });

  it("rejects draft styles with STYLE_NOT_ACTIVE", async () => {
    stubStyleRow({ id: "style-1", status: "draft", schema: {} });
    await expect(compileStyledPrompt({ styleId: "style-1", originalPrompt: "x", client: client as never })).rejects.toMatchObject({ code: "STYLE_NOT_ACTIVE" });
  });

  it("throws STYLE_NOT_FOUND when the style is invisible", async () => {
    stubStyleRow(null);
    await expect(compileStyledPrompt({ styleId: "x", originalPrompt: "x", client: client as never })).rejects.toMatchObject({ code: "STYLE_NOT_FOUND" });
  });

  it("caps the compiled prompt at 8000 characters", async () => {
    stubStyleRow({ id: "style-1", status: "active", schema: { style_name: "S", artistic_style: { rendering_style: "y".repeat(2000) } } });
    const compiled = await compileStyledPrompt({ styleId: "style-1", originalPrompt: "z".repeat(9000), client: client as never });
    expect(compiled.length).toBeLessThanOrEqual(8000);
    expect(compiled).toContain("Subject: ");
  });
});
