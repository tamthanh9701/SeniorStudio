// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/env", () => ({
  getEnv: () => ({ STYLE_PROFILES_ENABLED: true }),
}));
vi.mock("../src/supabase/server", () => ({
  createClient: vi.fn(() => client),
  getServiceClient: vi.fn(() => serviceClient),
}));

import { GET, POST } from "../src/app/api/styles/route";
import { DELETE as deleteStyle, GET as getStyle, PATCH as patchStyle } from "../src/app/api/styles/[styleId]/route";
import { POST as uploadReference } from "../src/app/api/styles/[styleId]/references/route";


function builder(final: unknown, overrides: Record<string, unknown> = {}) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "insert", "update", "delete"]) {
    node[method] = vi.fn(() => node);
  }
  node.single = vi.fn(async () => final);
  node.maybeSingle = vi.fn(async () => final);
  // Thenable: awaiting any chain position resolves `final` (Supabase awaits
  // the whole builder, not only .single()).
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(final).then(onFulfilled);
  return Object.assign(node, overrides);
}

let client: Record<string, unknown>;
const serviceClient = { storage: { from: vi.fn() } };

function jsonRequest(url: string, body?: unknown, method = "POST") {
  return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  client = { auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) }, from: vi.fn() };
});

describe("GET /api/styles", () => {
  it("returns 401 when unauthenticated", async () => {
    (client.auth as { getUser: ReturnType<typeof vi.fn> }).getUser.mockResolvedValue({ data: { user: null } });
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("maps reference counts into the lightweight list", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn(async () => ({ data: [{ id: "s1", name: "A", status: "active", updated_at: "2026-01-01", style_references: [{ count: 3 }] }], error: null })),
    });
    const response = await GET();
    const body = await response.json();
    expect(body.styles[0]).toMatchObject({ id: "s1", referenceCount: 3 });
  });
});

describe("POST /api/styles", () => {
  it("creates a draft with the caller workspace", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "workspace_members") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn(async () => ({ data: { workspace_id: "ws-1" } })) };
      if (table === "styles") return { insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn(async () => ({ data: { id: "s1", name: "New", status: "draft", created_at: "t", updated_at: "t" }, error: null })) };
      return {};
    });
    const response = await POST(jsonRequest("http://localhost/api/styles", { name: "New" }));
    expect(response.status).toBe(201);
  });

  it("rejects invalid names with 400", async () => {
    const response = await POST(jsonRequest("http://localhost/api/styles", { name: "" }));
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/styles/[styleId]", () => {
  it("rejects unknown fields with 400 (strict schema)", async () => {
    const response = await patchStyle(jsonRequest("http://x", { schema: {} }, "PATCH"), { params: Promise.resolve({ styleId: "s1" }) });
    expect(response.status).toBe(400);
  });

  it("enforces the activation gate: no analysis → STYLE_NOT_READY", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({ data: { id: "s1", status: "draft", schema: {}, fingerprint: null, invariant_contract: null, analysis_meta: {} } })),
    });
    const response = await patchStyle(jsonRequest("http://x", { status: "active" }, "PATCH"), { params: Promise.resolve({ styleId: "s1" }) });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("STYLE_NOT_READY");
  });

  it("activates when analysis meta and fingerprint are present", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({ data: { id: "s1", status: "draft", schema: { style_name: "x" }, fingerprint: { v: 1 }, invariant_contract: { v: 1 }, analysis_meta: { analyzedAt: "2026-01-01" } } })),
      update: vi.fn().mockReturnThis(),
      single: vi.fn(async () => ({ data: { id: "s1", status: "active" }, error: null })),
    }));
    const response = await patchStyle(jsonRequest("http://x", { status: "active" }, "PATCH"), { params: Promise.resolve({ styleId: "s1" }) });
    expect(response.status).toBe(200);
  });
});

describe("DELETE /api/styles/[styleId]", () => {
  it("deletes the style and cleans storage paths", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "styles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: { id: "s1", workspace_id: "ws-1" } })),
          delete: vi.fn().mockReturnThis(),
        };
      }
      if (table === "style_references") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn(async () => ({ data: [{ storage_path: "ws/styles/s1/r1.png" }] })) };
      }
      return {};
    });
    const remove = vi.fn(async () => ({ error: null }));
    serviceClient.storage.from.mockReturnValue({ remove });
    const response = await deleteStyle(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ styleId: "s1" }) });
    expect(response.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(["ws/styles/s1/r1.png"]);
  });
});

describe("POST /api/styles/[styleId]/references", () => {
  function pngFile(name = "r.png"): File {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=";
    return new File([Buffer.from(base64, "base64")], name, { type: "image/png" });
  }
  function stubUploads(refCount = 0, insertResult: { data: unknown; error: unknown } = { data: { id: "r1" }, error: null }) {
    (client.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "styles") return builder({ data: { id: "s1", workspace_id: "ws-1" }, error: null });
      if (table === "style_references") {
        const node = builder({ data: null, error: null });
        // Count query awaits the .eq() result; insert query awaits the chain or .single().
        node.select = vi.fn((_columns?: unknown, options?: { count?: string }) => {
          if (options?.count === "exact") {
            const counted = builder({ count: refCount, error: null });
            return Object.assign(counted, { eq: vi.fn(() => counted) });
          }
          return node;
        });
        node.single = vi.fn(async () => insertResult);
        return node;
      }
      return builder({ data: null, error: null });
    });
  }

  it("returns 400 when the 9th reference would exceed the limit", async () => {
    stubUploads(8);
    const form = new FormData();
    form.append("files", pngFile());
    const response = await uploadReference(new Request("http://x", { method: "POST", body: form }), { params: Promise.resolve({ styleId: "s1" }) });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("TOO_MANY_REFERENCES");
  });

  it("returns 415 for a wrong magic-bytes/declared-MIME mismatch", async () => {
    stubUploads();
    const form = new FormData();
    form.append("files", new File([Buffer.from("GIF89a-not-really")], "fake.png", { type: "image/png" }));
    const response = await uploadReference(new Request("http://x", { method: "POST", body: form }), { params: Promise.resolve({ styleId: "s1" }) });
    expect(response.status).toBe(415);
  });

  it("returns 413 when a file exceeds 5 MB", async () => {
    stubUploads();
    const form = new FormData();
    form.append("files", new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    const response = await uploadReference(new Request("http://x", { method: "POST", body: form }), { params: Promise.resolve({ styleId: "s1" }) });
    expect(response.status).toBe(413);
  });

  it("removes the stored object when the insert fails", async () => {
    stubUploads(0, { data: null, error: { message: "db down" } });
    const upload = vi.fn(async () => ({ error: null }));
    const remove = vi.fn(async () => ({ error: null }));
    serviceClient.storage.from.mockReturnValue({ upload, remove });
    const form = new FormData();
    form.append("files", pngFile());
    const response = await uploadReference(new Request("http://x", { method: "POST", body: form }), { params: Promise.resolve({ styleId: "s1" }) });
    expect(response.status).toBe(500);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("cross-workspace isolation", () => {
  it("RLS-hidden style detail resolves to 404", async () => {
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({ data: null })),
    });
    const response = await getStyle(new Request("http://x"), { params: Promise.resolve({ styleId: "other" }) });
    expect(response.status).toBe(404);
  });
});
