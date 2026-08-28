import { NextRequest } from "next/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { server } from "@/lib/mcp/server";
import { getEnv, requireAuth0Config } from "@/env";

export async function POST(request: NextRequest) {
  const env = getEnv();

  // Check for Bearer token
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    // Return 401 with OAuth challenge if Auth0 is configured
    const auth0 = requireAuth0Config();
    if (auth0) {
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
            "WWW-Authenticate":
              'Bearer resource_metadata="/api/mcp/.well-known/oauth-protected-resource"',
          },
        }
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized",
        },
        id: null,
      }),
      { status: 401 }
    );
  }

  const token = authHeader.slice(7);

  try {
    let userId: string;
    let email: string;

    // Strategy 1: Try Auth0 JWT (for ChatGPT connector)
    const auth0 = requireAuth0Config();
    if (auth0) {
      try {
        const { verifyAuth0Token } = await import("@/lib/auth0");
        const claims = await verifyAuth0Token(token);

        if (claims.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Forbidden" },
              id: null,
            }),
            { status: 403 }
          );
        }

        userId = claims.sub;
        email = claims.email;
      } catch {
        // Auth0 verification failed, try Supabase next
        const supabase = await import("@/supabase/server").then((m) =>
          m.createClient()
        );
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser(token);

        if (error || !user) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Invalid token" },
              id: null,
            }),
            { status: 401 }
          );
        }

        if (user.email?.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Forbidden" },
              id: null,
            }),
            { status: 403 }
          );
        }

        userId = user.id;
        email = user.email;
      }
    } else {
      // Strategy 2: Supabase JWT only (no Auth0 configured)
      const supabase = await import("@/supabase/server").then((m) =>
        m.createClient()
      );
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(token);

      if (error || !user) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Invalid token" },
            id: null,
          }),
          { status: 401 }
        );
      }

      if (user.email?.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Forbidden" },
            id: null,
          }),
          { status: 403 }
        );
      }

      userId = user.id;
      email = user.email;
    }

    // Create transport with auth info
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Set auth info on server
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).authInfo = { userId, email };

    await server.connect(transport);

    const body = await request.json();

    // Convert NextRequest to compatible format
    const compatibleRequest = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      url: request.url,
      body: body,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await transport.handleRequest(compatibleRequest as any, body);

    return new Response(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
