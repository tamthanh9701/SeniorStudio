import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMcpEditor(server: McpServer) {
  server.resource(
    "asset-card",
    "ui://seniorstudio/asset-card.html",
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: `<!DOCTYPE html>
<html>
<head>
  <title>SeniorStudio Asset Card</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; max-width: 400px; }
    .image { width: 100%; height: auto; }
    .info { padding: 16px; }
    .title { font-weight: 600; margin-bottom: 8px; }
    .meta { color: #6b7280; font-size: 14px; }
    .actions { padding: 16px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; }
    .btn { padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-secondary { background: #f3f4f6; color: #374151; }
  </style>
</head>
<body>
  <div class="card">
    <img class="image" id="image" src="" alt="Asset" />
    <div class="info">
      <div class="title" id="title">Asset</div>
      <div class="meta" id="meta"></div>
    </div>
    <div class="actions">
      <button class="btn btn-primary" onclick="openInStudio()">Open in SeniorStudio</button>
      <button class="btn btn-secondary" onclick="download()">Download</button>
    </div>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    document.getElementById('image').src = params.get('url') || '';
    document.getElementById('title').textContent = params.get('name') || 'Asset';
    document.getElementById('meta').textContent = params.get('meta') || '';
    function openInStudio() { window.open(params.get('studioUrl') || '/', '_blank'); }
    function download() {
      const anchor = document.createElement('a');
      anchor.href = params.get('url') || '';
      anchor.download = params.get('name') || 'download';
      anchor.click();
    }
  </script>
</body>
</html>`,
        },
      ],
    })
  );

  server.tool(
    "open_editor",
    "Open fullscreen editor for an asset",
    {
      asset_id: z.string().uuid(),
      version_id: z.string().uuid().optional(),
    },
    async ({ asset_id, version_id }, extra) => {
      const userId = extra.authInfo?.extra?.userId;
      if (typeof userId !== "string") throw new Error("Unauthorized");

      const query = version_id ? `?version=${version_id}` : "";
      const editorUrl =
        `https://senior-studio.vercel.app/assets/${asset_id}/edit${query}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ editor_url: editorUrl }),
          },
        ],
      };
    }
  );
}
