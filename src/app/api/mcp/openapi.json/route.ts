import { NextResponse } from "next/server";
import {
  getAuth0Endpoints,
  MCP_RESOURCE,
  MCP_SCOPES,
} from "@/lib/auth0/metadata";

export async function GET() {
  const auth0 = getAuth0Endpoints();
  if (!auth0) {
    return NextResponse.json(
      { error: "Auth0 not configured" },
      { status: 503 }
    );
  }

  return NextResponse.json({
    openapi: "3.1.0",
    info: {
      title: "SeniorStudio MCP API",
      version: "1.0.0",
    },
    servers: [{ url: MCP_RESOURCE }],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: auth0.authorizationEndpoint,
              tokenUrl: auth0.tokenEndpoint,
              scopes: Object.fromEntries(
                MCP_SCOPES.map((scope) => [scope, scope])
              ),
            },
          },
        },
      },
    },
    security: [{ oauth2: [...MCP_SCOPES] }],
  });
}
