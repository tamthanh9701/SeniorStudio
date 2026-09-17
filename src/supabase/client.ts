import { createBrowserClient } from "@supabase/ssr";
import { getPublicEnv } from "../env";

export function createClient() {
  const env = getPublicEnv();

  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      // Secure in production; a Secure cookie is dropped over plain http, which is how
      // the app is served locally.
      cookieOptions: { secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" },
    }
  );
}
