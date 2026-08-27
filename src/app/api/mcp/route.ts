import { NextRequest } from "next/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { server } from "@/lib/mcp/server";
import { verifyJwt } from "@/lib/auth0";
import { getEnv } from "@/env";

export async function POST(request: NextRequest) {
  const env = getEnv();
  
  // Check for OAuth token
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized",
          data: {
            _meta: {
              "mcp/www_authenticate": "Bearer",
            },
          },
        },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer resource_metadata="/api/mcp/.well-known/oauth-protected-resource"',
        },
      }
    );
  }

  const token = authHeader.slice(7);
  
  try {
    const claims = await verifyJwt(token);
    
    // Verify email matches owner
    if (claims.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Forbidden",
          },
          id: null,
        }),
        { status: 403 }
      );
    }

    // Create transport with auth info
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Set auth info on server
    (server as any).authInfo = { userId: claims.sub, email: claims.email };

    await server.connect(transport);
    
    const body = await request.json();
    
    // Convert NextRequest to compatible format
    const compatibleRequest = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      url: request.url,
      body: body,
    };
    
    await transport.handleRequest(compatibleRequest as any, body);

    return new Response(
      JSON.stringify((transport as any).response),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal error",
        },
        id: null,
      }),
      { status: 500 }
    );
  }
}

export async function GET() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "Method not allowed",
      },
      id: null,
    }),
    { status: 405 }
  );
}
