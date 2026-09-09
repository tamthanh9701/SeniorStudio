import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createClient, getServiceClient } from "@/supabase/server";
import { getEnv } from "@/env";
import { ingestImage, getSignedUrl } from "@/lib/assets/service";
import { registerMcpEditor } from "@/lib/mcp/editor";
import { openAiFileSchema } from "@/lib/mcp/files";
import { IMAGE_SAVE_WIDGET_HTML, IMAGE_SAVE_WIDGET_URI } from "@/lib/mcp/image-save-widget";
import {
  requireMcpAuthContext,
  requireMcpScope,
  requireProjectOwnership,
  requireAssetOwnership,
  requireVersionOwnership,
} from "@/lib/mcp/auth";

export function createMcpServer() {
  const server = new McpServer({
    name: "SeniorStudio",
    version: "1.0.0",
    description: "SeniorStudio project and asset operations. Web generation uses explicit OpenAI and Google AI Studio APIs; MCP remains an optional ChatGPT inbound channel for saving external images.",
  });

server.registerResource("seniorstudio-image-save", IMAGE_SAVE_WIDGET_URI, {}, async () => ({
  contents: [{
    uri: IMAGE_SAVE_WIDGET_URI,
    mimeType: "text/html;profile=mcp-app",
    text: IMAGE_SAVE_WIDGET_HTML,
    _meta: {
      ui: { prefersBorder: true },
      "openai/widgetDescription": "Choose an exact ChatGPT Library file or upload a local image, then save it to SeniorStudio.",
      "openai/widgetPrefersBorder": true,
    },
  }],
}));

server.registerTool(
  "open_generated_image_saver",
  {
    title: "Open generated image saver",
    description: "Open the SeniorStudio file picker after an image has been generated. Use this when direct save_generated_image file handoff is unavailable.",
    inputSchema: z.object({
      project_id: z.string().uuid(),
      project_name: z.string().min(1),
      name: z.string().optional(),
      prompt: z.string().optional(),
      notes: z.string().optional(),
    }),
    outputSchema: z.object({
      mode: z.literal("generate"), project_id: z.string().uuid(), project_name: z.string(),
      name: z.string().nullable(), prompt: z.string().nullable(), notes: z.string().nullable(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: IMAGE_SAVE_WIDGET_URI },
      "openai/outputTemplate": IMAGE_SAVE_WIDGET_URI,
      "openai/toolInvocation/invoking": "Opening image saver…",
      "openai/toolInvocation/invoked": "Image saver ready.",
    },
  },
  async ({ project_id, project_name, name, prompt, notes }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, "assets:write");
    await requireProjectOwnership(getServiceClient(), ctx.workspaceId, project_id);
    const structuredContent = {
      mode: "generate" as const, project_id, project_name,
      name: name ?? null, prompt: prompt ?? null, notes: notes ?? null,
    };
    return { structuredContent, content: [{ type: "text", text: "Choose the exact image file in the SeniorStudio saver." }] };
  }
);

server.registerTool(
  "open_edited_image_saver",
  {
    title: "Open edited image saver",
    description: "Open the SeniorStudio file picker after editing an image. The chosen file is saved as a child of the specified parent version.",
    inputSchema: z.object({ asset_id: z.string().uuid(), parent_version_id: z.string().uuid(), prompt: z.string().optional(), notes: z.string().optional() }),
    outputSchema: z.object({ mode: z.literal("edit"), asset_id: z.string().uuid(), parent_version_id: z.string().uuid(), prompt: z.string().nullable(), notes: z.string().nullable() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: IMAGE_SAVE_WIDGET_URI }, "openai/outputTemplate": IMAGE_SAVE_WIDGET_URI },
  },
  async ({ asset_id, parent_version_id, prompt, notes }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, "assets:write");
    const client = getServiceClient();
    const asset = await requireAssetOwnership(client, ctx.workspaceId, asset_id);
    const parent = await requireVersionOwnership(client, ctx.workspaceId, parent_version_id);
    if (parent.asset_id !== asset.id) throw new Error("NOT_FOUND");
    const structuredContent = { mode: "edit" as const, asset_id, parent_version_id, prompt: prompt ?? null, notes: notes ?? null };
    return { structuredContent, content: [{ type: "text", text: "Choose the exact edited image file in the SeniorStudio saver." }] };
  }
);


// Tool: create_project
server.tool(
  "create_project",
  "Create a new project",
  { name: z.string().min(1).max(100) },
  async ({ name }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'projects:write');
    const serviceClient = getServiceClient();

    const { data, error } = await serviceClient
      .from("projects")
      .insert({ workspace_id: ctx.workspaceId, name })
      .select()
      .single();

    if (error) throw error;
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// Tool: list_projects
server.tool(
  "list_projects",
  "List all projects",
  {},
  async (_, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:read');
    const serviceClient = getServiceClient();

    const { data, error } = await serviceClient
      .from("projects")
      .select("*")
      .eq("workspace_id", ctx.workspaceId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// Tool: list_assets
server.tool(
  "list_assets",
  "List assets in a project",
  {
    project_id: z.string().uuid(),
    cursor: z.string().optional(),
    limit: z.number().min(1).max(50).default(20),
  },
  async ({ project_id, cursor, limit }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:read');
    const serviceClient = getServiceClient();

    // Verify project belongs to caller's workspace before listing
    await requireProjectOwnership(serviceClient, ctx.workspaceId, project_id);

    let query = serviceClient
      .from("assets")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (cursor) {
      query = query.gt("created_at", cursor);
    }

    const { data, error } = await query;
    if (error) throw error;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            assets: data,
            next_cursor: data.length === limit ? data[data.length - 1].created_at : null,
          }),
        },
      ],
    };
  }
);

// Tool: get_asset
server.tool(
  "get_asset",
  "Get asset details with current version",
  { asset_id: z.string().uuid() },
  async ({ asset_id }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:read');
    const serviceClient = getServiceClient();

    // Verify asset belongs to caller's workspace through project ownership
    await requireAssetOwnership(serviceClient, ctx.workspaceId, asset_id);

    const { data: asset, error: assetError } = await serviceClient
      .from("assets")
      .select("*")
      .eq("id", asset_id)
      .single();

    if (assetError) throw assetError;

    let signedUrl = null;
    if (asset.current_version_id) {
      const { data: version } = await serviceClient
        .from("asset_versions")
        .select("storage_path")
        .eq("id", asset.current_version_id)
        .single();

      if (version) {
        signedUrl = await getSignedUrl(serviceClient, version.storage_path);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ asset, current_version: asset.current_version_id, signed_url: signedUrl }),
        },
      ],
    };
  }
);

// Tool: get_asset_history
server.tool(
  "get_asset_history",
  "Get version history for an asset",
  { asset_id: z.string().uuid() },
  async ({ asset_id }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:read');
    const serviceClient = getServiceClient();

    // Verify asset belongs to caller's workspace through project ownership
    await requireAssetOwnership(serviceClient, ctx.workspaceId, asset_id);

    const { data: versions, error } = await serviceClient
      .from("asset_versions")
      .select("*")
      .eq("asset_id", asset_id)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return { content: [{ type: "text", text: JSON.stringify({ asset: { id: asset_id }, versions }) }] };
  }
);

// Tool: get_edit_context
server.tool(
  "get_edit_context",
  "Get context for editing an asset",
  {
    asset_id: z.string().uuid(),
    version_id: z.string().uuid().optional(),
  },
  async ({ asset_id, version_id }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:read');
    const serviceClient = getServiceClient();

    // Verify asset belongs to caller's workspace through project ownership
    await requireAssetOwnership(serviceClient, ctx.workspaceId, asset_id);

    const { data: asset, error: assetError } = await serviceClient
      .from("assets")
      .select("*")
      .eq("id", asset_id)
      .single();

    if (assetError) throw assetError;

    const targetVersionId = version_id || asset.current_version_id;
    if (!targetVersionId) throw new Error("No version available");

    const { data: version, error: versionError } = await serviceClient
      .from("asset_versions")
      .select("*")
      .eq("id", targetVersionId)
      .single();

    if (versionError) throw versionError;

    const signedUrl = await getSignedUrl(serviceClient, version.storage_path);

    // Get prompt history from versions
    const { data: allVersions } = await serviceClient
      .from("asset_versions")
      .select("prompt, source, created_at")
      .eq("asset_id", asset_id)
      .order("created_at", { ascending: true });

    const promptHistory = allVersions
      ?.filter((v) => v.prompt)
      .map((v) => ({ prompt: v.prompt, source: v.source, timestamp: v.created_at })) || [];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            asset,
            version,
            signed_url: signedUrl,
            prompt_history: promptHistory,
            ingredients: [], // Milestone 3
          }),
        },
      ],
    };
  }
);

// Tool: save_generated_image
server.registerTool(
  "save_generated_image",
  {
    title: "Save generated image",
    description:
      "Persist the exact image file generated by ChatGPT in a SeniorStudio project. Call this only when ChatGPT supplies a complete native image file parameter. Otherwise call open_generated_image_saver so the user can choose the file through the official ChatGPT file picker.",
    inputSchema: z.object({
      project_id: z.string().uuid(),
      image: openAiFileSchema,
      name: z.string().optional(),
      prompt: z.string().optional(),
      notes: z.string().optional(),
    }),
    _meta: {
      "openai/fileParams": ["image"],
      "openai/widgetAccessible": true,
      ui: { visibility: ["model", "app"] },
    },
  },
  async ({ project_id, image, name, prompt, notes }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:write');
    const serviceClient = getServiceClient();

    // Verify project belongs to caller's workspace
    await requireProjectOwnership(serviceClient, ctx.workspaceId, project_id);

    const result = await ingestImage({
      client: serviceClient,
      workspaceId: ctx.workspaceId,
      projectId: project_id,
      fileUrl: image.download_url,
      source: "chatgpt",
      name,
      prompt,
      metadata: { notes, file_id: image.file_id },
    });

    const signedUrl = await getSignedUrl(serviceClient, result.version.storage_path);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            asset: result.asset,
            version: result.version,
            signed_url: signedUrl,
          }),
        },
      ],
    };
  }
);

// Tool: save_edited_image
server.registerTool(
  "save_edited_image",
  {
    title: "Save edited image",
    description:
      "Persist the exact edited image as an immutable child version. Call this only with a complete native image file parameter. Otherwise call open_edited_image_saver so the user can choose the file through the official ChatGPT file picker.",
    inputSchema: z.object({
      asset_id: z.string().uuid(),
      parent_version_id: z.string().uuid(),
      image: openAiFileSchema,
      prompt: z.string().optional(),
      notes: z.string().optional(),
    }),
    _meta: {
      "openai/fileParams": ["image"],
      "openai/widgetAccessible": true,
      ui: { visibility: ["model", "app"] },
    },
  },
  async ({ asset_id, parent_version_id, image, prompt, notes }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:write');
    const serviceClient = getServiceClient();

    // Verify asset belongs to caller's workspace through project ownership
    const asset = await requireAssetOwnership(serviceClient, ctx.workspaceId, asset_id);

    const result = await ingestImage({
      client: serviceClient,
      workspaceId: ctx.workspaceId,
      projectId: asset.project_id,
      assetId: asset_id,
      parentVersionId: parent_version_id,
      fileUrl: image.download_url,
      source: "chatgpt",
      prompt,
      metadata: { notes, file_id: image.file_id },
    });

    const signedUrl = await getSignedUrl(serviceClient, result.version.storage_path);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            asset: result.asset,
            version: result.version,
            signed_url: signedUrl,
          }),
        },
      ],
    };
  }
);

// Tool: export_asset
server.tool(
  "export_asset",
  "Export an asset version",
  {
    version_id: z.string().uuid(),
    format: z.literal("original").optional(),
  },
  async ({ version_id, format }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:read');
    const serviceClient = getServiceClient();

    // Verify version belongs to caller's workspace through asset→project ownership
    const version = await requireVersionOwnership(serviceClient, ctx.workspaceId, version_id);

    const signedUrl = await getSignedUrl(serviceClient, version.storage_path);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            file_name: `export.${version.mime_type.split("/")[1]}`,
            mime_type: version.mime_type,
            signed_url: signedUrl,
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          }),
        },
      ],
    };
  }
);

// Tool: show_asset
server.tool(
  "show_asset",
  "Show asset card",
  {
    asset_id: z.string().uuid(),
    version_id: z.string().uuid().optional(),
  },
  async ({ asset_id, version_id }, extra) => {
    const ctx = requireMcpAuthContext(extra);
    requireMcpScope(ctx, 'assets:read');
    const serviceClient = getServiceClient();

    // Verify asset belongs to caller's workspace through project ownership
    await requireAssetOwnership(serviceClient, ctx.workspaceId, asset_id);

    const { data: asset, error: assetError } = await serviceClient
      .from("assets")
      .select("*")
      .eq("id", asset_id)
      .single();

    if (assetError) throw assetError;

    const targetVersionId = version_id || asset.current_version_id;
    if (!targetVersionId) throw new Error("No version available");

    const { data: version, error: versionError } = await serviceClient
      .from("asset_versions")
      .select("*")
      .eq("id", targetVersionId)
      .single();

    if (versionError) throw versionError;

    const signedUrl = await getSignedUrl(serviceClient, version.storage_path);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            asset,
            version,
            signed_url: signedUrl,
          }),
        },
      ],
      _meta: {
        "openai/fileParams": ["image"],
        "mcp/www_authenticate": "Bearer",
      },
    };
  }
);

  registerMcpEditor(server);
  return server;
}
