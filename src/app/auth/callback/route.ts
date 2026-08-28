import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  console.log("auth_callback", {
    hasCode: Boolean(code),
    error,
    errorDescription,
  });

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorDescription || error)}`, url.origin)
    );
  }

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=no_code", url.origin));
  }

  // Redirect to /projects with the code in URL
  // The exchange will happen on the client side
  return NextResponse.redirect(
    new URL(`/auth/exchange?code=${encodeURIComponent(code)}`, url.origin)
  );
}
