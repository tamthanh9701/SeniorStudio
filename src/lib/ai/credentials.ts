import type { SupabaseClient } from "@supabase/supabase-js";
import { AiProviderSchema } from "@/db/ai-jobs";

export type ProviderCredentialSource = {
  /** Authenticated user client (RLS applies). */
  user?: SupabaseClient;
  /** Service-role client for worker/queue contexts. */
  service?: SupabaseClient;
};

async function fromTable(client: SupabaseClient, provider: string) {
  const { data } = await client.from("provider_settings").select("api_key").eq("provider", provider).maybeSingle();
  return data?.api_key ?? null;
}

/**
 * Resolves the API key for a provider from per-workspace UI configuration,
 * falling back to the legacy process environment.
 */
export async function getProviderApiKey(provider: string, source: ProviderCredentialSource): Promise<string | null> {
  const parsed = AiProviderSchema.safeParse(provider);
  if (!parsed.success) return null;
  if (source.user) {
    const key = await fromTable(source.user, parsed.data);
    if (key) return key;
  }
  if (source.service) {
    const key = await fromTable(source.service, parsed.data);
    if (key) return key;
  }
  const envKey = parsed.data === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
  return envKey ?? null;
}
