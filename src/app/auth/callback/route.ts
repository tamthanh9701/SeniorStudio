import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorDescription || error)}`, url.origin)
    );
  }

  return NextResponse.redirect(new URL("/login", url.origin));
}
