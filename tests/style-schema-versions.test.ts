import { describe, expect, it, vi } from "vitest";
import { appendSchemaVersion, getSchemaVersions } from "../src/lib/style/schema-versions";

function clientStub() {
  const insert = vi.fn(async () => ({ error: null }));
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit"]) chain[name] = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: "v2" }, { id: "v1" }], error: null }).then(resolve);
  const from = vi.fn((table: string) => table === "style_schema_versions" ? { ...chain, insert } : chain);
  return { client: { from }, insert, chain };
}

describe("style schema versions", () => {
  it("inserts a version payload", async () => {
    const { client, insert } = clientStub();
    await appendSchemaVersion(client as never, "style-1", { source: "manual", schema: { style_name: "S" }, metadata: { reason: "edit" } });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ style_id: "style-1", source: "manual", schema: { style_name: "S" } }));
  });

  it("requests newest versions first with a limit", async () => {
    const { client, chain } = clientStub();
    const versions = await getSchemaVersions(client as never, "style-1", 7);
    expect(chain.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(7);
    expect(versions).toEqual([{ id: "v2" }, { id: "v1" }]);
  });
});
