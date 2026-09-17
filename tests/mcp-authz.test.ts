// Regression: an authenticated stranger must never be joined to a workspace. The MCP
// identity resolver used to call bootstrap_owner_workspace() for any verified token,
// which added that email to the first workspace in the database - with signups enabled
// that handed any new account the production tenant (2026-09-17 review).
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceClient = { from: vi.fn(), rpc: vi.fn() };

vi.mock("@/supabase/server", () => ({
  getServiceClient: () => serviceClient,
  createClient: vi.fn(),
}));

import { resolveMcpAuthContext } from "../src/lib/mcp/identity";

const identity = (overrides: Partial<{ subject: string; email: string; emailVerified: boolean }> = {}) => ({
  subject: "user-1",
  email: "member@example.com",
  emailVerified: true,
  provider: "supabase" as const,
  ...overrides,
});

/** `from(...).select(...).eq(...).maybeSingle()` answering with one row (or none). */
function membership(row: unknown) {
  const node: Record<string, unknown> = {};
  node.select = vi.fn(() => node);
  node.eq = vi.fn(() => node);
  node.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  return node;
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceClient.from = vi.fn(() => membership(null));
  serviceClient.rpc = vi.fn(async () => ({ data: null, error: null }));
});

describe("MCP identity resolution", () => {
  it("refuses an identity with no membership row and creates nothing", async () => {
    await expect(resolveMcpAuthContext(identity({ email: "stranger@example.com" }))).rejects.toThrow(/Unauthorized/);
    expect(serviceClient.rpc).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed address", async () => {
    await expect(resolveMcpAuthContext(identity({ emailVerified: false }))).rejects.toThrow(/Unauthorized/);
    expect(serviceClient.rpc).not.toHaveBeenCalled();
  });

  it("resolves a member to their workspace", async () => {
    serviceClient.from = vi.fn(() => membership({ workspace_id: "ws-1", supabase_user_id: "user-1", auth0_sub: null, email: "member@example.com" }));
    await expect(resolveMcpAuthContext(identity())).resolves.toMatchObject({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("refuses a membership row that belongs to a different identity", async () => {
    serviceClient.from = vi.fn(() => membership({ workspace_id: "ws-1", supabase_user_id: "someone-else", auth0_sub: null, email: "member@example.com" }));
    await expect(resolveMcpAuthContext(identity())).rejects.toThrow(/Unauthorized/);
  });
});
