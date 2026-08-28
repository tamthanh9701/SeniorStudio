import { NextResponse } from "next/server";
import { requireAuth0Config } from "@/env";

export async function GET() {
  const config = requireAuth0Config();

  if (!config) {
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
    servers: [
      {
        url: "https://senior-studio.vercel.app/api/mcp",
      },
    ],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${config.issuerBaseURL}/authorize`,
              tokenUrl: `${config.issuerBaseURL}/oauth/token`,
              scopes: {
                openid: "OpenID Connect",
                email: "Email address",
                profile: "User profile",
                "assets:read": "Read assets",
                "assets:write": "Write assets",
                "projects:write": "Write projects",
              },
            },
          },
        },
      },
    },
    security: [
      {
        oauth2: [
          "openid",
          "email",
          "profile",
          "assets:read",
          "assets:write",
          "projects:write",
        ],
      },
    ],
  });
}
