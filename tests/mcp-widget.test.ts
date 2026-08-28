import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/lib/mcp/server";
import { IMAGE_SAVE_WIDGET_URI } from "../src/lib/mcp/image-save-widget";

describe("SeniorStudio image saver widget", () => {
  it("publishes render tools and an MCP Apps resource", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "widget-contract", version: "1.0.0" });
    await server.connect(serverTransport); await client.connect(clientTransport);

    const { tools } = await client.listTools();
    for (const name of ["open_generated_image_saver", "open_edited_image_saver"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?._meta?.ui).toEqual({ resourceUri: IMAGE_SAVE_WIDGET_URI });
      expect(tool?._meta?.["openai/outputTemplate"]).toBe(IMAGE_SAVE_WIDGET_URI);
    }
    for (const name of ["save_generated_image", "save_edited_image"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?._meta?.["openai/widgetAccessible"]).toBe(true);
    }

    const resource = await client.readResource({ uri: IMAGE_SAVE_WIDGET_URI });
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : "").toContain("window.openai.selectFiles");
    expect(resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : "").toContain("window.openai.getFileDownloadUrl");
    expect(resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : "").toContain("window.openai.callTool");

    await client.close(); await server.close();
  });
});
