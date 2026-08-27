import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    "resource": "https://api.seniorstudio.com/api/mcp",
    "authorization_servers": [
      {
        "issuer": process.env.AUTH0_ISSUER_BASE_URL,
        "audience": process.env.AUTH0_AUDIENCE,
      }
    ]
  });
}
