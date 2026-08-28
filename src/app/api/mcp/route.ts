import { NextRequest } from "next/server";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { server } from "@/lib/mcp/server";
import { getEnv, requireAuth0Config } from "@/env";
import { MCP_RESOURCE, MCP_RESOURCE_METADATA } from "@/lib/auth0/metadata";
import { resolveMcpAuthContext, type McpIdentity } from "@/lib/mcp/identity";

const REQUIRED_SCOPES = [
  "openid",
  "email",
  "profile",
  "assets:read",
  "assets:write",
  "projects:write",
];

function unauthorized(message = "Unauthorized") {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message,
        data: {
          _meta: {
            "mcp/www_authenticate":
              `Bearer resource_metadata="${MCP_RESOURCE_METADATA}", ` +
              `scope="${REQUIRED_SCOPES.join(" ")}"`,
          },
        },
      },
      id: null,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate":
          `Bearer resource_metadata="${MCP_RESOURCE_METADATA}", ` +
          `scope="${REQUIRED_SCOPES.join(" ")}"`,
      },
    }
  );
}

function forbidden() {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Forbidden" },
      id: null,
    },
    { status: 403 }
  );
}

async function verifySupabaseIdentity(
  token: string
): Promise<McpIdentity | null> {
  const { createClient } = await import("@/supabase/server");
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user?.email) return null;
  return {
    subject: user.id,
    email: user.email,
    provider: "supabase",
  };
}

async function verifyIdentity(token: string): Promise<{
  identity: McpIdentity;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
} | null> {
  if (requireAuth0Config()) {
    try {
      const { verifyAuth0Token } = await import("@/lib/auth0");
      const claims = await verifyAuth0Token(token);
      if (!claims.email || claims.email_verified !== true) return null;

      return {
        identity: {
          subject: claims.sub,
          email: claims.email,
          provider: "auth0",
        },
        clientId: claims.clientId,
        scopes: claims.scopes,
        expiresAt: claims.exp,
      };
    } catch {
      // Supabase JWT fallback supports local MCP inspection and web sessions.
    }
  }

  const identity = await verifySupabaseIdentity(token);
  if (!identity) return null;
  return {
    identity,
    clientId: "seniorstudio-web",
    scopes: REQUIRED_SCOPES,
  };
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return unauthorized();

  const verified = await verifyIdentity(authHeader.slice(7));
  if (!verified) return unauthorized("Invalid token");

  const ownerEmail = getEnv().OWNER_EMAIL.trim().toLowerCase();
  if (verified.identity.email.trim().toLowerCase() !== ownerEmail) {
    return forbidden();
  }

  try {
    const context = await resolveMcpAuthContext(verified.identity);
    const authInfo: AuthInfo = {
      token: authHeader.slice(7),
      clientId: verified.clientId,
      scopes: verified.scopes,
      expiresAt: verified.expiresAt,
      resource: new URL(MCP_RESOURCE),
      extra: {
        userId: context.userId,
        workspaceId: context.workspaceId,
        email: context.email,
        provider: context.provider,
      },
    };

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request, { authInfo });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal error";
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message },
        id: null,
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
