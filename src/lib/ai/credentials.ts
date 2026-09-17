import type { SupabaseClient } from "@supabase/supabase-js";
import { AiProviderSchema } from "@/db/ai-jobs";

export type ProviderCredentialSource = {
  /** Resolved owning workspace; required. Authorization is the caller's job. */
  workspaceId: string;
  /** Service-role client: the key column is not readable by a user session (0054). */
  service: SupabaseClient;
};

async function fromTable(client: SupabaseClient, workspaceId: string, provider: string) {
  const { data, error } = await client
    .from("provider_settings")
    .select("api_key")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`PROVIDER_KEY_LOOKUP_FAILED: ${error.message}`);
  return data?.api_key ?? null;
}

/**
 * Resolves the API key for a provider strictly from the owning workspace's
 * configuration. No environment fallback: a missing key means unconfigured.
 */
export async function getProviderApiKey(provider: string, source: ProviderCredentialSource): Promise<string | null> {
  const parsed = AiProviderSchema.safeParse(provider);
  if (!parsed.success) return null;
  // The caller resolves and authorizes `workspaceId` before asking for the key.
  return fromTable(source.service, source.workspaceId, parsed.data);
}
