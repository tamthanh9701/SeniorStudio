// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockMaybeSingle = vi.fn();

vi.mock("@/supabase/server", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
  getServiceClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn(() => ({ select: mockSelect, eq: mockEq, maybeSingle: mockMaybeSingle })),
  })),
}));

vi.mock("@/lib/ai/models", () => ({
  resolveUserWorkspaceId: vi.fn(async () => "ws-1"),
}));

vi.mock("@/env", () => ({
  getEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  }),
}));

import { enforceAiQuota } from "@/lib/ai/quota";

function fakeRequest(path = "/api/style/test") {
  return new Request(`http://localhost${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockReturnValue({ select: mockSelect, eq: mockEq, maybeSingle: mockMaybeSingle });
  mockEq.mockReturnValue({ select: mockSelect, eq: mockEq, maybeSingle: mockMaybeSingle });
  mockMaybeSingle.mockResolvedValue({ data: { workspace_id: "ws-1" }, error: null });
  mockRpc.mockResolvedValue({ data: { image: { limit: 100, held: 0, charged: 0 } }, error: null });
});

describe("enforceAiQuota", () => {
  it("returns 401 when user not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("returns 429 quota_exceeded when held+charged >= limit", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockRpc.mockResolvedValue({ data: { image: { limit: 50, held: 25, charged: 30 } }, error: null });
    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      const body = await result.response.json();
      expect(body.error.code).toBe("quota_exceeded");
    }
  });

  it("returns 503 QUOTA_UNAVAILABLE on RPC error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.error.code).toBe("QUOTA_UNAVAILABLE");
    }
  });

  it("returns 200 ok when quota available", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockRpc.mockResolvedValue({ data: { image: { limit: 100, held: 10, charged: 20 } }, error: null });
    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(true);
  });
});
