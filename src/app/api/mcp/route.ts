import { NextRequest } from "next/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { server } from "@/lib/mcp/server";
import { getEnv } from "@/env";

export async function POST(request: NextRequest) {
  const env = getEnv();
  
  // Check for Supabase JWT token
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized",
        },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  const token = authHeader.slice(7);
  
  try {
    // Verify Supabase JWT and get user
    const supabase = await import("@/supabase/server").then(m => m.createClient());
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Invalid token",
          },
          id: null,
        }),
        { status: 401 }
      );
    }
    
    // Verify email matches owner
    if (user.email?.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
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
    (server as any).authInfo = { userId: user.id, email: user.email };

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
