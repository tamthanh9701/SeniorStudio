import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

export const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OWNER_EMAIL: z.string().email(),
  AUTH0_ISSUER_BASE_URL: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  AUTH0_OWNER_SUB: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),
  GOOGLE_IMAGE_MODEL: z.string().default("gemini-3.1-flash-image"),
  AI_WORKER_SECRET: z.string().min(1),
  SUPABASE_FUNCTION_URL: z.string().url().optional(),
  CRON_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;
export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function getPublicEnv(): PublicEnv {
  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!result.success) {
    throw new Error("Invalid public Supabase environment variables");
  }
  return result.data;
}

export function getEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Environment validation failed:", result.error.flatten());
    throw new Error("Invalid environment variables");
  }

  return result.data;
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
