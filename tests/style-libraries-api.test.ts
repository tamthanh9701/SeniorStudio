// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/env", () => ({
  getEnv: () => ({ STYLE_PROFILES_ENABLED: true }),
}));
vi.mock("../src/supabase/server", () => ({
  createClient: vi.fn(() => client),
}));

import { GET, POST } from "../src/app/api/styles/route";

let client: Record<string, unknown>;

function builder(final: unknown, overrides: Record<string, unknown> = {}) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "insert"]) {
    node[method] = vi.fn(() => node);
  }
  node.single = vi.fn(async () => final);
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(final).then(onFulfilled);
  return Object.assign(node, overrides);
}

function jsonRequest(url: string, body?: unknown, method = "POST") {
  return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: vi.fn(),
  };
});

describe("GET /api/styles", () => {
  it("returns empty array when no styles", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue(builder({ data: [], error: null }));
    const response = await GET(new Request("http://localhost/api/styles"));
    const body = await response.json();
    expect(body.styles).toEqual([]);
  });

  it("includes libraryId in response", async () => {
    const styleData = [{ id: "s1", name: "Test", status: "draft", created_at: "", updated_at: "", library_id: "550e8400-e29b-41d4-a716-446655440000", style_references: [{ count: 2 }] }];
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue(builder({ data: styleData, error: null }));
    
    const response = await GET(new Request("http://localhost/api/styles"));
    const body = await response.json();
    expect(body.styles[0].libraryId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(body.styles[0].referenceCount).toBe(2);
  });

  it("filters by libraryId when provided", async () => {
    const mock = builder({ data: [], error: null });
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    
    await GET(new Request("http://localhost/api/styles?libraryId=550e8400-e29b-41d4-a716-446655440000"));
    expect(mock.eq).toHaveBeenCalledWith("library_id", "550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("POST /api/styles", () => {
  it("creates style with libraryId", async () => {
    const insertMock = vi.fn().mockReturnValue(builder({ data: { id: "s1", name: "New Style", status: "draft", created_at: "", updated_at: "", library_id: "550e8400-e29b-41d4-a716-446655440000" }, error: null }));
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "workspace_members") return builder({ data: { workspace_id: "ws-1" }, error: null });
      if (table === "styles") return builder({ data: null, error: null }, { insert: insertMock });
      return builder({ data: null, error: null });
    });
    
    const response = await POST(jsonRequest("http://localhost/api/styles", { name: "New Style", libraryId: "550e8400-e29b-41d4-a716-446655440000" }));
    expect(response.status).toBe(201);
    
    // Verify insert was called with library_id
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ library_id: "550e8400-e29b-41d4-a716-446655440000" }));
  });

  it("creates style without libraryId (null by default)", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "workspace_members") return builder({ data: { workspace_id: "ws-1" }, error: null });
      if (table === "styles") return builder({ data: { id: "s1", name: "New Style", status: "draft", created_at: "", updated_at: "", library_id: null }, error: null });
      return builder({ data: null, error: null });
    });
    
    const response = await POST(jsonRequest("http://localhost/api/styles", { name: "New Style" }));
    expect(response.status).toBe(201);
  });
});
