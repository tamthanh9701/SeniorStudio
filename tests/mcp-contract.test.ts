import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/lib/mcp/server";

describe("MCP image handoff descriptors", () => {
  it("publishes ChatGPT file parameters for save tools", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({
      name: "contract-test",
      version: "1.0.0",
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    for (const name of ["save_generated_image", "save_edited_image"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?._meta?.["openai/fileParams"]).toEqual(["image"]);
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["image"]),
        properties: {
          image: {
            type: "object",
            required: expect.arrayContaining(["download_url", "file_id"]),
          },
        },
      });
      expect(tool?.inputSchema).not.toMatchObject({
        properties: { image: { properties: { download_url: { format: "uri" } } } },
      });
    }

    await client.close();
    await server.close();
  });
});
