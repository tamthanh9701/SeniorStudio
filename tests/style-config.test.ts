import type * as EnvModule from "../src/env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../src/env";

const mocks = vi.hoisted(() => ({
  getProviderApiKey: vi.fn(),
  getEnv: vi.fn(),
}));

vi.mock("../src/lib/ai/credentials", () => ({ getProviderApiKey: mocks.getProviderApiKey }));
vi.mock("../src/env", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return { ...original, getEnv: mocks.getEnv };
});

import { resolveStyleProviderConfig } from "../src/lib/style/providers/config";

const source = { user: {} as never, service: {} as never };

beforeEach(() => {
  mocks.getEnv.mockReset();
  mocks.getProviderApiKey.mockReset();
});

describe("style feature flag", () => {
  it("defaults enabled and parses the literal false string correctly", () => {
    expect(envSchema.shape.STYLE_PROFILES_ENABLED.parse(undefined)).toBe(true);
    expect(envSchema.shape.STYLE_PROFILES_ENABLED.parse("true")).toBe(true);
    expect(envSchema.shape.STYLE_PROFILES_ENABLED.parse("false")).toBe(false);
  });
});

describe("style provider resolution", () => {
  it("uses Google when its configured key exists and no provider is forced", async () => {
    mocks.getEnv.mockReturnValue({ STYLE_ANALYSIS_PROVIDER: undefined, STYLE_ANALYSIS_MODEL: undefined });
    mocks.getProviderApiKey.mockImplementation(async (provider: string) => provider === "google" ? "google-key" : null);

    await expect(resolveStyleProviderConfig(source)).resolves.toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      apiKey: "google-key",
    });
    expect(mocks.getProviderApiKey).toHaveBeenCalledTimes(1);
  });

  it("falls back to OpenAI only when Google is unavailable", async () => {
    mocks.getEnv.mockReturnValue({ STYLE_ANALYSIS_PROVIDER: undefined, STYLE_ANALYSIS_MODEL: undefined });
    mocks.getProviderApiKey.mockImplementation(async (provider: string) => provider === "openai" ? "openai-key" : null);

    await expect(resolveStyleProviderConfig(source)).resolves.toEqual({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "openai-key",
    });
    expect(mocks.getProviderApiKey.mock.calls.map(([provider]) => provider)).toEqual(["google", "openai"]);
  });

  it("does not borrow a key from a different explicitly selected provider", async () => {
    mocks.getEnv.mockReturnValue({ STYLE_ANALYSIS_PROVIDER: "openai", STYLE_ANALYSIS_MODEL: "gpt-4.1-mini" });
    mocks.getProviderApiKey.mockImplementation(async (provider: string) => provider === "google" ? "google-key" : null);

    await expect(resolveStyleProviderConfig(source)).rejects.toMatchObject({
      code: "STYLE_ANALYSIS_NOT_CONFIGURED",
    });
    expect(mocks.getProviderApiKey).toHaveBeenCalledWith("openai", source);
    expect(mocks.getProviderApiKey).toHaveBeenCalledTimes(1);
  });
});
