import { describe, expect, it, vi } from "vitest";
import { ingestImageBytes } from "../src/lib/assets/service";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=", "base64");

describe("asset ingestion transaction boundary", () => {
  it("uses explicit IDs in storage path and removes upload after RPC failure", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const rpc = vi.fn().mockResolvedValue({ error: { message: "database unavailable" } });
    const client = {
      storage: { from: () => ({ upload, remove }) },
      rpc,
    } as never;

    await expect(ingestImageBytes({
      client, workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222",
      bytes: onePixelPng, source: "chatgpt", prompt: "test image",
    })).rejects.toMatchObject({ message: "database unavailable" });

    const storagePath = upload.mock.calls[0][0] as string;
    const rpcArguments = rpc.mock.calls[0][1] as Record<string, string>;
    expect(storagePath).toContain(`/${rpcArguments.p_asset_id}/${rpcArguments.p_version_id}/source.png`);
    expect(rpcArguments.p_storage_path).toBe(storagePath);
    expect(remove).toHaveBeenCalledWith([storagePath]);
  });
});
