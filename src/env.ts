import { z } from "zod";

export const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OWNER_EMAIL: z.string().email(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_ORCHESTRATOR_MODEL: z.string().default("gpt-5.6").optional(),
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
