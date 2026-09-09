import type { SupabaseClient } from "@supabase/supabase-js";
import { AiProviderSchema } from "@/db/ai-jobs";

export type ProviderCredentialSource = {
  /** Resolved owning workspace; required. Authorization is the caller's job. */
  workspaceId: string;
  /** Authenticated user client (RLS applies). */
  user?: SupabaseClient;
  /** Service-role client for worker/queue contexts. */
  service?: SupabaseClient;
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
  if (source.user) {
    const key = await fromTable(source.user, source.workspaceId, parsed.data);
    if (key) return key;
  }
  if (source.service) {
    const key = await fromTable(source.service, source.workspaceId, parsed.data);
    if (key) return key;
  }
  return null;
}
