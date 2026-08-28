import { z } from "zod";

export const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OWNER_EMAIL: z.string().email(),
  AUTH0_ISSUER_BASE_URL: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ORCHESTRATOR_MODEL: z.string().optional(),
  CRON_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Environment validation failed:", result.error.flatten());
    throw new Error("Invalid environment variables");
  }

  _env = result.data;
  return _env;
}

export function requireOpenAIKey(): string {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for direct generation");
  }
  return env.OPENAI_API_KEY;
}

export function requireAuth0Config() {
  const env = getEnv();
  if (!env.AUTH0_ISSUER_BASE_URL || !env.AUTH0_AUDIENCE) {
    return null;
  }
  return {
    issuerBaseURL: env.AUTH0_ISSUER_BASE_URL,
    audience: env.AUTH0_AUDIENCE,
  };
}
