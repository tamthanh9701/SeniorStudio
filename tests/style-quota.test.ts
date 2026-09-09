import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/supabase/server", () => ({
  createClient: vi.fn(),
  getServiceClient: vi.fn(),
}));

import { enforceAiQuota } from "../src/lib/ai/quota";
import { createClient, getServiceClient } from "@/supabase/server";

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockMaybeSingle = vi.fn();

function setupAuthenticatedUser(userId = "user-1") {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
}

function setupWorkspaceMember(workspaceId = "ws-1") {
  mockSelect.mockReturnValue({ select: mockSelect, eq: mockEq, maybeSingle: mockMaybeSingle });
  mockEq.mockReturnValue({ select: mockSelect, eq: mockEq, maybeSingle: mockMaybeSingle });
  mockMaybeSingle.mockResolvedValue({ data: { workspace_id: workspaceId }, error: null });
}

function setupQuotaStatus(status: Record<string, { limit: number; held: number; charged: number }>) {
  mockRpc.mockResolvedValue({ data: status, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  (createClient as ReturnType<typeof vi.fn>).mockReturnValue({ auth: { getUser: mockGetUser } });
  (getServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({
    rpc: mockRpc,
    from: vi.fn(() => ({ select: mockSelect, eq: mockEq, maybeSingle: mockMaybeSingle })),
  });
});

function fakeRequest(path = "/api/style/test") {
  return new Request(`http://localhost${path}`);
}

describe("enforceAiQuota", () => {
  it("allows request when usage is below limit", async () => {
    setupAuthenticatedUser();
    setupWorkspaceMember();
    setupQuotaStatus({
      image: { limit: 100, held: 5, charged: 10 },
    });

    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(true);
  });

  it("blocks with 429 when usage is at the limit", async () => {
    setupAuthenticatedUser();
    setupWorkspaceMember();
    setupQuotaStatus({
      image: { limit: 100, held: 0, charged: 100 },
    });

    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      const body = await result.response.json();
      expect(body.error.code).toBe("quota_exceeded");
    }
  });

  it("blocks with 429 when held+charged exceeds limit", async () => {
    setupAuthenticatedUser();
    setupWorkspaceMember();
    setupQuotaStatus({
      brain: { limit: 50, held: 30, charged: 25 },
    });

    const result = await enforceAiQuota(fakeRequest(), "brain");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
    }
  });

  it("returns 503 when DB status query fails", async () => {
    setupAuthenticatedUser();
    setupWorkspaceMember();
    mockRpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });

    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.error.code).toBe("QUOTA_UNAVAILABLE");
    }
  });

  it("returns 401 when user is not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("allows when limit is zero (disabled)", async () => {
    setupAuthenticatedUser();
    setupWorkspaceMember();
    process.env.AI_DAILY_LIMIT_IMAGE = "0";

    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(true);

    delete process.env.AI_DAILY_LIMIT_IMAGE;
  });

  it("returns 503 when workspace member lookup fails", async () => {
    setupAuthenticatedUser();
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "not found" } });

    const result = await enforceAiQuota(fakeRequest(), "image");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.error.code).toBe("QUOTA_UNAVAILABLE");
    }
  });
});
