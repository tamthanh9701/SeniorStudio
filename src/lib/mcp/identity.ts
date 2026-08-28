import { getServiceClient } from "@/supabase/server";

export interface McpIdentity {
  subject: string;
  email: string;
  provider: "auth0" | "supabase";
}

export interface McpAuthContext {
  userId: string;
  workspaceId: string;
  email: string;
  provider: McpIdentity["provider"];
}

export async function resolveMcpAuthContext(
  identity: McpIdentity
): Promise<McpAuthContext> {
  const serviceClient = getServiceClient();
  const normalizedEmail = identity.email.trim().toLowerCase();
  const { data: workspaceId, error } = await serviceClient.rpc(
    "bootstrap_owner_workspace",
    {
      p_email: normalizedEmail,
      p_supabase_user_id:
        identity.provider === "supabase" ? identity.subject : null,
      p_auth0_sub:
        identity.provider === "auth0" ? identity.subject : null,
    }
  );

  if (error || typeof workspaceId !== "string") {
    throw new Error(error?.message ?? "Workspace bootstrap failed");
  }

  const { data: member, error: memberError } = await serviceClient
    .from("workspace_members")
    .select("supabase_user_id")
    .ilike("email", normalizedEmail)
    .single();

  if (memberError || !member) throw new Error("Workspace member not found");

  return {
    userId: member.supabase_user_id ?? identity.subject,
    workspaceId,
    email: normalizedEmail,
    provider: identity.provider,
  };
}
