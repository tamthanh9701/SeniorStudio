// OpenAI vision adapter — uses the existing `openai` dependency with
// chat.completions and data-URL image parts. No image-generation model.
import OpenAI from "openai";
import { StyleError } from "../errors";
import type { StyleAnalysisProvider, StyleAnalysisRequest, StyleAnalysisResult } from "./types";

function classifyOpenAiError(error: unknown): StyleError {
  if (error instanceof StyleError) return error;
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    const detail = error.message?.substring(0, 300) ?? "";
    if (status === 429) return new StyleError("STYLE_ANALYSIS_RATE_LIMITED", `OpenAI rate limited style analysis: ${detail}`);
    if (status === 401 || status === 403) return new StyleError("STYLE_ANALYSIS_FAILED", `OpenAI rejected style analysis credentials: ${detail}`);
    return new StyleError("STYLE_ANALYSIS_FAILED", `OpenAI style analysis failed (${status}): ${detail}`);
  }
  return new StyleError("STYLE_ANALYSIS_FAILED", `OpenAI request error: ${error instanceof Error ? error.message : "network failure"}`);
}

function isRetryableOpenAiError(error: unknown): boolean {
  const status = error instanceof OpenAI.APIError ? (error.status ?? 0) : 0;
  return status === 408 || status === 429 || status >= 500 || status === 0;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function retryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof OpenAI.APIError) {
    const retryAfter = Number(error.headers?.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  }
  return attempt === 1 ? 1000 : 3000;
}

// The OpenAI SDK's internal retries are disabled (maxRetries: 0); this wrapper
// applies the bounded retry policy (408/429/5xx/network, 3 attempts).
async function requestWithBoundedRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableOpenAiError(error) || attempt === 3) break;
      await sleep(retryDelayMs(error, attempt) + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}

export class OpenAiStyleProvider implements StyleAnalysisProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey, timeout: 150_000, maxRetries: 0 });
    this.model = model;
  }

  async analyze(input: StyleAnalysisRequest): Promise<StyleAnalysisResult> {
    try {
      const completion = await requestWithBoundedRetry(() =>
        this.client.chat.completions.create({
          model: this.model,
          temperature: 0.3,
          max_tokens: 8192,
          messages: [
            { role: "system", content: input.systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: input.userMessage },
                ...input.references.map(
                  (reference): { type: "image_url"; image_url: { url: string } } => ({
                    type: "image_url",
                    image_url: {
                      url: `data:${reference.mimeType};base64,${reference.buffer.toString("base64")}`,
                    },
                  }),
                ),
              ],
            },
          ],
        }),
      );
      const rawText = completion.choices[0]?.message?.content ?? "";
      if (!rawText) throw new StyleError("STYLE_ANALYSIS_FAILED", "No response content from OpenAI");
      return { schema: rawText, rawText };
    } catch (error) {
      throw classifyOpenAiError(error);
    }
  }
}
