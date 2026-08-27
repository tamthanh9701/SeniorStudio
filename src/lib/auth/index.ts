import { getEnv } from "@/env";
import { getServiceClient } from "@/supabase/server";

export async function getClaims() {
  const supabase = await import("@/supabase/server").then((m) => m.createClient());
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return null;
  }

  return {
    sub: user.id,
    email: user.email!,
  };
}

export async function requireOwner() {
  const claims = await getClaims();
  const env = getEnv();

  if (!claims || claims.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    throw new Error("Unauthorized");
  }

  return claims;
}

export async function bindAuth0Sub(supabaseUserId: string, auth0Sub: string) {
  const serviceClient = getServiceClient();
  
  const { error } = await serviceClient
    .from("workspace_members")
    .update({ auth0_sub: auth0Sub })
    .eq("supabase_user_id", supabaseUserId);

  if (error) throw error;
}
