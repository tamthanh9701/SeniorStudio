import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { server } from "@/lib/mcp/server";

// Add fullscreen editor resource
server.resource(
  "asset-card",
  "ui://seniorstudio/asset-card.html",
  async (uri) => {
    return {
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
    
    function openInStudio() {
      window.open(params.get('studioUrl') || '/', '_blank');
    }
    
    function download() {
      const a = document.createElement('a');
      a.href = params.get('url') || '';
      a.download = params.get('name') || 'download';
      a.click();
    }
  </script>
</body>
</html>`,
        },
      ],
    };
  }
);

// Add fullscreen editor tool
server.tool(
  "open_editor",
  "Open fullscreen editor for an asset",
  {
    asset_id: z.string().uuid(),
    version_id: z.string().uuid().optional(),
  },
  async ({ asset_id, version_id }, extra) => {
    const userId = (extra as Record<string, unknown>)?.authInfo as { userId: string } | undefined;
    if (!userId?.userId) throw new Error("Unauthorized");

    // Return URL to web editor
    const editorUrl = `/projects/placeholder/assets/${asset_id}/editor${version_id ? `?version=${version_id}` : ""}`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            editor_url: editorUrl,
            message: "Open this URL in a browser to access the fullscreen editor",
          }),
        },
      ],
    };
  }
);

export { server };
