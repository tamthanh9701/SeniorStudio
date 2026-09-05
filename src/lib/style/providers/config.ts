// Style analysis provider configuration. API keys resolve through the existing
// provider_settings table via getProviderApiKey; no dedicated style key exists.
import { getEnv } from "@/env";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProviderApiKey } from "@/lib/ai/credentials";
import { StyleError } from "../errors";

export type StyleProviderId = "openai" | "google";

export interface StyleProviderConfig {
  provider: StyleProviderId;
  model: string;
  apiKey: string;
}

const DEFAULT_MODELS: Record<StyleProviderId, string> = {
  google: "gemini-2.5-flash",
  openai: "gpt-4o",
};


/**
 * Resolves the vision provider for style analysis: explicit env override first,
 * then key presence, then OpenAI. Throws STYLE_ANALYSIS_NOT_CONFIGURED when no
 * key is reachable through provider_settings or the environment.
 */
export async function resolveStyleProviderConfig(source: {
  user: SupabaseClient;
  service: SupabaseClient;
}): Promise<StyleProviderConfig> {
  const env = getEnv();
  let provider: StyleProviderId;
  let apiKey: string | null;

  if (env.STYLE_ANALYSIS_PROVIDER) {
    provider = env.STYLE_ANALYSIS_PROVIDER;
    apiKey = await getProviderApiKey(provider, source);
  } else {
    const googleKey = await getProviderApiKey("google", source);
    if (googleKey) {
      provider = "google";
      apiKey = googleKey;
    } else {
      provider = "openai";
      apiKey = await getProviderApiKey("openai", source);
    }
  }

  if (!apiKey) {
    throw new StyleError(
      "STYLE_ANALYSIS_NOT_CONFIGURED",
      `No API key configured for style analysis provider "${provider}"`,
    );
  }

  return {
    provider,
    model: env.STYLE_ANALYSIS_MODEL || DEFAULT_MODELS[provider],
    apiKey,
  };
}
