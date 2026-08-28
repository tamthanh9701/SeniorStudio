import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { wrappedPrompt } from "../src/chatgpt/page.js";

describe("bridge contracts", () => {
  it("applies safe defaults without exposing credentials to prompts", () => {
    const config = loadConfig({ NODE_ENV: "test", SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "secret", BRIDGE_WORKER_ID: "worker" });
    expect(config.CHATGPT_PROFILE_DIR).toBe("/data/chrome-profile");
    expect(config.CHATGPT_JOB_TIMEOUT_SECONDS).toBe(300);
    expect(wrappedPrompt("generate", "a teapot")).not.toContain("secret");
  });

  it("wraps operations deterministically", () => {
    expect(wrappedPrompt("chat", "hello")).toBe("hello\n\nAnswer in text.");
    expect(wrappedPrompt("generate", "a teapot")).toContain("create exactly one image");
    expect(wrappedPrompt("edit", "make it red")).toContain("Edit the attached source image");
  });
});
