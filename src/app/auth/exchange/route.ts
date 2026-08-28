import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  console.log("auth_exchange", { hasCode: Boolean(code) });

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=no_code", url.origin));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  console.log("auth_exchange_result", {
    hasSession: Boolean(data?.session),
    error: error?.message,
  });

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, url.origin)
    );
  }

  return NextResponse.redirect(new URL("/projects", url.origin));
}
