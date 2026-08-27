import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { getEnv } from "@/env";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    
    if (!error) {
      const env = getEnv();
      const { data: { user } } = await supabase.auth.getUser();
      
      if (user && user.email?.toLowerCase() === env.OWNER_EMAIL.toLowerCase()) {
        return NextResponse.redirect(`${origin}${next}`);
      } else {
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/login?error=unauthorized`);
      }
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
