import { describe, it, expect, beforeEach } from "vitest";
import { getEnv } from "../src/env";

describe("Environment Validation", () => {
  const validEnv = {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    OWNER_EMAIL: "owner@example.com",
    AUTH0_ISSUER_BASE_URL: "https://example.auth0.com/",
    AUTH0_AUDIENCE: "https://api.example.com",
    OPENAI_API_KEY: "sk-test",
    GEMINI_API_KEY: "gemini-test-key",
    AI_WORKER_SECRET: "worker-secret",
    CRON_SECRET: "cron-secret",
  };

  beforeEach(() => {
    process.env = { NODE_ENV: "test" };
  });

  it("should validate complete environment", () => {
    process.env = { ...process.env, ...validEnv };
    expect(() => getEnv()).not.toThrow();
  });

  it("should fail with missing required fields", () => {
    expect(() => getEnv()).toThrow("Invalid environment variables");
  });
});
