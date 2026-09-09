// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/ai-jobs", () => ({
  AiProviderSchema: {
    safeParse: (v: string) => {
      if (v === "openai" || v === "google") return { success: true, data: v };
      return { success: false };
    },
  },
}));

import { getProviderApiKey } from "@/lib/ai/credentials";
import { ownedStorageObjectFromPath } from "@/lib/assets/ownership";
import { downloadImageBytes } from "@/lib/assets/download";
import { signOwnedUrl } from "@/lib/assets/ownership";

function makeChain() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
  return chain;
}
function mockClient() {
  const chain = makeChain();
  return { from: vi.fn(() => chain) } as unknown;
}

describe("getProviderApiKey", () => {
  it("returns null for invalid provider string", async () => {
    const result = await getProviderApiKey("invalid-provider", { workspaceId: "ws-1" });
    expect(result).toBeNull();
  });

  it("returns null when provider is valid but no key configured", async () => {
    const client = { from: vi.fn(() => makeChain()) } as never;
    const result = await getProviderApiKey("openai", { user: client, workspaceId: "ws-1" });
    expect(result).toBeNull();
  });
});

describe("ownedStorageObjectFromPath", () => {
  it("rejects paths without UUID workspace segment", () => {
    expect(() => ownedStorageObjectFromPath("not-a-uuid/some/path.png")).toThrow("INVALID_STORAGE_PATH");
    expect(() => ownedStorageObjectFromPath("assets/some/path.png")).toThrow("INVALID_STORAGE_PATH");
    expect(() => ownedStorageObjectFromPath("12345/some/path.png")).toThrow("INVALID_STORAGE_PATH");
  });

  it("accepts valid UUID workspace paths", () => {
    const wsId = "550e8400-e29b-41d4-a716-446655440000";
    const obj = ownedStorageObjectFromPath(`${wsId}/some/path/source.png`);
    expect(obj.workspaceId).toBe(wsId);
  });
});

describe("downloadImageBytes security", () => {
  it("rejects when allowedHosts is empty", async () => {
    await expect(
      downloadImageBytes(new URL("https://allowed.example.com/img.png"), { allowedHosts: new Set() })
    ).rejects.toMatchObject({ code: "DOWNLOAD_HOST_NOT_CONFIGURED" });
  });

  it("rejects non-HTTPS URLs", async () => {
    await expect(
      downloadImageBytes(new URL("http://allowed.example.com/img.png"), { allowedHosts: new Set(["allowed.example.com"]) })
    ).rejects.toMatchObject({ code: "DOWNLOAD_NOT_HTTPS" });
  });

  it("rejects IP literal hosts", async () => {
    await expect(
      downloadImageBytes(new URL("https://192.168.1.1/img.png"), { allowedHosts: new Set(["192.168.1.1"]) })
    ).rejects.toMatchObject({ code: "DOWNLOAD_IP_LITERAL" });
  });
});

describe("signOwnedUrl", () => {
  it("throws when storage client returns an error", async () => {
    const wsId = "550e8400-e29b-41d4-a716-446655440000";
    const owned = ownedStorageObjectFromPath(`${wsId}/test/source.png`);
    const errorClient = {
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(async () => ({ data: null, error: { message: "storage unavailable" } })),
        })),
      },
    } as never;
    await expect(signOwnedUrl(errorClient, owned)).rejects.toThrow();
  });
});
