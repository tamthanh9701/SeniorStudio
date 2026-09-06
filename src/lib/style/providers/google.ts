// Google Gemini vision adapter — direct REST, ported from Restyle commit dfab2fe
// (ai-actions.ts callGemini, lines 379–417), minus URL/dataURL fetching: bytes
// arrive already uploaded through /api/styles/[id]/references.
import { StyleError } from "../errors";
import type { StyleAnalysisProvider, StyleAnalysisRequest, StyleAnalysisResult } from "./types";
import { withProviderRetry } from "./retry";

const GOOGLE_BASE = "https://generativelanguage.googleapis.com";

function classifyHttpError(status: number, body: string): StyleError {
  const detail = body.substring(0, 300);
  if (status === 429) {
    return new StyleError("STYLE_ANALYSIS_RATE_LIMITED", `Google rate limited style analysis: ${detail}`);
  }
  if (status === 401 || status === 403) {
    return new StyleError("STYLE_ANALYSIS_FAILED", `Google rejected style analysis credentials: ${detail}`);
  }
  return new StyleError("STYLE_ANALYSIS_FAILED", `Google style analysis failed (${status}): ${detail}`);
}

export class GoogleStyleProvider implements StyleAnalysisProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async analyze(input: StyleAnalysisRequest): Promise<StyleAnalysisResult> {
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
      { text: input.userMessage },
    ];
    for (const reference of input.references) {
      parts.push({
        inlineData: {
          mimeType: reference.mimeType,
          data: reference.buffer.toString("base64"),
        },
      });
    }

    const response = await withProviderRetry(
      { attempts: 3, baseDelayMs: 1000, timeoutMs: input.timeoutMs },
      (signal) =>
        fetch(`${GOOGLE_BASE}/v1beta/models/${this.model}:generateContent`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: input.systemPrompt }] },
            contents: [{ role: "user", parts }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
          }),
        }),
    ).catch((error: unknown) => {
      if (error instanceof StyleError) throw error;
      throw new StyleError("STYLE_ANALYSIS_FAILED", `Google request error: ${error instanceof Error ? error.message : "network failure"}`);
    });

    if (!response.ok) {
      throw classifyHttpError(response.status, await response.text().catch(() => ""));
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data?.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text ?? "";
    if (!rawText) throw new StyleError("STYLE_ANALYSIS_FAILED", "No response content from Gemini");
    return { schema: rawText, rawText };
  }
}
