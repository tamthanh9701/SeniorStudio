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
    resource: "https://senior-studio.vercel.app/api/mcp",
    authorization_servers: [
      {
        issuer: config.issuerBaseURL,
        audience: config.audience,
      },
    ],
  });
}
