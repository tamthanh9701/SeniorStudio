import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("../src/env", () => ({
  getEnv: () => ({ STYLE_ANALYSIS_PROVIDER: undefined, STYLE_ANALYSIS_MODEL: undefined }),
}));

import { GoogleStyleProvider } from "../src/lib/style/providers/google";
import { pickAiPromptSchema, stripMarkdownFence } from "../src/lib/style/providers/prompts";
import { StyleError } from "../src/lib/style/errors";

const summary = {
  total: 1, ok: 1, failed: 0, hasAnyAlpha: false, dominantAssetFormat: "unknown",
  dominantColors: [], qualityReport: { hasLowResolutionReferences: false, lowResolutionCount: 0, tinyIconSourceCount: 0, pixelArtAmbiguity: "unknown", likelyArtifacts: [], recommendedPolicy: {}, warnings: [] },
  stats: [], warnings: [],
} as never;

function okResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function googlePayload(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

const baseInput = {
  references: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
  systemPrompt: "system",
  userMessage: "user",
  referenceSummary: summary,
  timeoutMs: 1000,
};

beforeEach(() => { fetchMock.mockReset(); });

describe("google style adapter", () => {
  it("returns the raw text on success and posts inline image data", async () => {
    fetchMock.mockResolvedValue(okResponse(googlePayload("{\"style_name\":\"X\"}")));
    const provider = new GoogleStyleProvider("key", "gemini-2.5-flash");
    const result = await provider.analyze(baseInput);
    expect(result.rawText).toContain("style_name");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(String((init.body as string))).toContain("inlineData");
    // The key must ride in a header, never in the logged/URL surface of the body.
    expect(url).not.toContain("key=");
  });

  it("strips markdown fences and recognizes schemas", () => {
    expect(stripMarkdownFence("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
    expect(pickAiPromptSchema({ style_name: "S" })).toMatchObject({ style_name: "S" });
    expect(pickAiPromptSchema({ result: { subject_type: "object" } })).toMatchObject({ subject_type: "object" });
    expect(pickAiPromptSchema({ unrelated: true })).toBe(null);
  });

  it("maps 401 to STYLE_ANALYSIS_FAILED without retry", async () => {
    fetchMock.mockResolvedValue(new Response("denied", { status: 401 }));
    const provider = new GoogleStyleProvider("key", "gemini-2.5-flash");
    await expect(provider.analyze(baseInput)).rejects.toMatchObject({ code: "STYLE_ANALYSIS_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 429 within bounds and respects Retry-After", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(okResponse(googlePayload("{\"style_name\":\"X\"}")));
    const provider = new GoogleStyleProvider("key", "gemini-2.5-flash");
    const result = await provider.analyze(baseInput);
    expect(result.rawText).toContain("style_name");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after exactly 3 attempts on 500", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const provider = new GoogleStyleProvider("key", "gemini-2.5-flash");
    await expect(provider.analyze(baseInput)).rejects.toBeInstanceOf(StyleError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("wraps network failures in STYLE_ANALYSIS_FAILED after bounded retries", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const provider = new GoogleStyleProvider("key", "gemini-2.5-flash");
    await expect(provider.analyze(baseInput)).rejects.toMatchObject({ code: "STYLE_ANALYSIS_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps 429 exhaustion to STYLE_ANALYSIS_RATE_LIMITED", async () => {
    fetchMock.mockResolvedValue(new Response("limited", { status: 429 }));
    const provider = new GoogleStyleProvider("key", "gemini-2.5-flash");
    await expect(provider.analyze(baseInput)).rejects.toMatchObject({ code: "STYLE_ANALYSIS_RATE_LIMITED" });
  });
});

afterEach(() => { vi.restoreAllMocks(); });
