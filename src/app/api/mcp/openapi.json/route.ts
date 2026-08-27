import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    openapi: "3.1.0",
    info: {
      title: "SeniorStudio MCP API",
      version: "1.0.0",
    },
    servers: [
      {
        url: "/api/mcp",
      },
    ],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${process.env.AUTH0_ISSUER_BASE_URL}/authorize`,
              tokenUrl: `${process.env.AUTH0_ISSUER_BASE_URL}/oauth/token`,
              scopes: {
                "openid": "OpenID Connect",
                "email": "Email address",
                "profile": "User profile",
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
        oauth2: ["openid", "email", "profile", "assets:read", "assets:write", "projects:write"],
      },
    ],
  });
}
