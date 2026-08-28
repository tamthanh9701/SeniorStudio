import { z } from "zod";

const booleanString = z.preprocess((value) => value ?? "false", z.enum(["true", "false"])).transform((value) => value === "true");
const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  BRIDGE_WORKER_ID: z.string().min(1),
  CHATGPT_PROFILE_DIR: z.string().default("/data/chrome-profile"),
  CHATGPT_DIAGNOSTICS_DIR: z.string().default("/data/diagnostics"),
  CHATGPT_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  CHATGPT_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30000).default(2000),
  CHATGPT_HEADLESS: booleanString,
  BRIDGE_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  BRIDGE_BROWSER_URL: z.string().url().optional(),
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
});

export type BridgeConfig = z.infer<typeof schema>;
export function loadConfig(environment: Record<string, string | undefined> = process.env): BridgeConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) throw new Error(`Invalid bridge configuration: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  return parsed.data;
}
