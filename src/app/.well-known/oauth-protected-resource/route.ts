import { NextResponse } from "next/server";
import { getProtectedResourceMetadata } from "@/lib/auth0/metadata";

export async function GET() {
  const metadata = getProtectedResourceMetadata();
  if (!metadata) {
    return NextResponse.json(
      { error: "Auth0 not configured" },
      { status: 503 }
    );
  }

  return NextResponse.json(metadata);
}
