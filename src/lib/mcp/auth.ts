import type { SupabaseClient } from "@supabase/supabase-js";

export type McpToolScope = "projects:write" | "assets:read" | "assets:write";

export type AuthorizedMcpContext = {
  userId: string;
  workspaceId: string;
  scopes: ReadonlySet<string>;
  provider: "auth0" | "supabase";
  subject: string;
};

export function requireMcpAuthContext(extra: Record<string, unknown>): AuthorizedMcpContext {
  const authInfo = extra?.authInfo as Record<string, unknown> | undefined;
  const data = authInfo?.extra as Record<string, unknown> | undefined;
  if (!data || typeof data.userId !== "string" || typeof data.workspaceId !== "string" ||
      typeof data.subject !== "string" || (data.provider !== "auth0" && data.provider !== "supabase")) {
    throw new Error("Unauthorized");
  }
  const raw = Array.isArray(data.scopes) ? data.scopes : typeof data.scopes === "string" ? [data.scopes] : [];
  const scopes = new Set(raw.filter((s): s is string => typeof s === "string").flatMap((s) => s.split(/\s+/)).filter(Boolean));
  return { userId: data.userId, workspaceId: data.workspaceId, scopes, provider: data.provider, subject: data.subject };
}

export function requireMcpScope(context: AuthorizedMcpContext, scope: McpToolScope) {
  if (!context.scopes.has(scope)) throw new Error("INSUFFICIENT_SCOPE");
}

export async function requireProjectOwnership(client: SupabaseClient, workspaceId: string, projectId: string) {
  const { data, error } = await client.from("projects").select("id,workspace_id").eq("id", projectId).maybeSingle();
  if (error) throw error;
  if (!data || data.workspace_id !== workspaceId) throw new Error("NOT_FOUND");
  return data;
}

export async function requireAssetOwnership(client: SupabaseClient, workspaceId: string, assetId: string) {
  const { data, error } = await client.from("assets").select("id,project_id").eq("id", assetId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("NOT_FOUND");
  await requireProjectOwnership(client, workspaceId, data.project_id);
  return data;
}

export async function requireVersionOwnership(client: SupabaseClient, workspaceId: string, versionId: string) {
  const { data, error } = await client.from("asset_versions").select("id,asset_id,storage_path,mime_type").eq("id", versionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("NOT_FOUND");
  await requireAssetOwnership(client, workspaceId, data.asset_id);
  return data;
}
