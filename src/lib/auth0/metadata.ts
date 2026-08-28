import { requireAuth0Config } from "@/env";

export const MCP_RESOURCE = "https://senior-studio.vercel.app/api/mcp";
export const MCP_RESOURCE_METADATA =
  "https://senior-studio.vercel.app/.well-known/oauth-protected-resource";
export const MCP_SCOPES = [
  "openid",
  "email",
  "profile",
  "assets:read",
  "assets:write",
  "projects:write",
] as const;

export function getProtectedResourceMetadata() {
  const config = requireAuth0Config();
  if (!config) return null;

  return {
    resource: MCP_RESOURCE,
    authorization_servers: [config.issuerBaseURL],
    scopes_supported: [...MCP_SCOPES],
    resource_documentation: "https://senior-studio.vercel.app",
  };
}

export function getAuth0Endpoints() {
  const config = requireAuth0Config();
  if (!config) return null;

  const issuer = config.issuerBaseURL.replace(/\/+$/, "");
  return {
    issuer: `${issuer}/`,
    audience: config.audience,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
  };
}
