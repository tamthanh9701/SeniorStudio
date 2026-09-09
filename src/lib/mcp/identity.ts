import { getServiceClient } from "@/supabase/server";

export interface McpIdentity {
  subject: string;
  email: string;
  emailVerified?: boolean;
  provider: "auth0" | "supabase";
}

export interface McpAuthContext {
  userId: string;
  workspaceId: string;
  email: string;
  provider: McpIdentity["provider"];
  subject: string;
}

function identityColumn(identity: McpIdentity) {
  return identity.provider === "auth0" ? "auth0_sub" : "supabase_user_id";
}

export async function resolveMcpAuthContext(
  identity: McpIdentity,
): Promise<McpAuthContext> {
  const serviceClient = getServiceClient();
  const normalizedEmail = identity.email.trim().toLowerCase();
  if (!normalizedEmail || (identity.provider === "auth0" && identity.emailVerified !== true)) {
    throw new Error("Unauthorized");
  }
  const column = identityColumn(identity);
  const { data: existing, error: lookupError } = await serviceClient
    .from("workspace_members")
    .select(`workspace_id,supabase_user_id,auth0_sub,email`)
    .eq(column, identity.subject)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!existing) {
    const { data: byEmail, error: emailError } = await serviceClient
      .from("workspace_members").select("workspace_id,supabase_user_id,auth0_sub,email")
      .ilike("email", normalizedEmail).maybeSingle();
    if (emailError) throw emailError;
    if (byEmail && ((identity.provider === "auth0" && byEmail.auth0_sub && byEmail.auth0_sub !== identity.subject) ||
      (identity.provider === "supabase" && byEmail.supabase_user_id && byEmail.supabase_user_id !== identity.subject))) {
      throw new Error("Unauthorized");
    }
    const { error: bootstrapError } = await serviceClient.rpc("bootstrap_owner_workspace", {
      p_email: normalizedEmail,
      p_supabase_user_id: identity.provider === "supabase" ? identity.subject : null,
      p_auth0_sub: identity.provider === "auth0" ? identity.subject : null,
    });
    if (bootstrapError) throw bootstrapError;
  }
  const { data: member, error: memberError } = await serviceClient
    .from("workspace_members").select("workspace_id,supabase_user_id,auth0_sub,email")
    .eq(column, identity.subject).maybeSingle();
  if (memberError) throw memberError;
  if (!member || member.email.trim().toLowerCase() !== normalizedEmail) throw new Error("Unauthorized");
  const userId = member.supabase_user_id;
  if (!userId || (identity.provider === "auth0" && member.auth0_sub !== identity.subject) ||
      (identity.provider === "supabase" && userId !== identity.subject)) throw new Error("Unauthorized");
  return { userId, workspaceId: member.workspace_id, email: normalizedEmail, provider: identity.provider, subject: identity.subject };
}
