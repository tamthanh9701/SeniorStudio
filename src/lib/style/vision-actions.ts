import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/supabase/server";
import { StyleError } from "./errors";
import { resolveStyleProviderConfig } from "./providers/config";
import { stripMarkdownFence } from "./providers/prompts";
import { RetryableHttpError, withProviderRetry } from "./providers/retry";

const GOOGLE_BASE = "https://generativelanguage.googleapis.com";

async function loadImage(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const parsed = new URL(url);
  const storageOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid.local").origin;
  if (parsed.protocol !== "https:" || parsed.origin !== storageOrigin) {
    throw new StyleError("INVALID_REQUEST", "Tuning images must use SeniorStudio storage URLs");
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new StyleError("FILE_UNAVAILABLE", `Unable to load tuning image (${response.status})`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  if (!mimeType.startsWith("image/")) throw new StyleError("UNSUPPORTED_IMAGE_TYPE", "Tuning URL did not return an image");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 10 * 1024 * 1024) throw new StyleError("REFERENCE_TOO_LARGE", "Tuning image exceeds 10 MB");
  return { buffer, mimeType };
}

export async function runStyleVisionAction(params: {
  client: SupabaseClient;
  workspaceId: string;
  systemPrompt: string;
  userMessage: string;
  imageUrls: string[];
}): Promise<unknown> {
  const config = await resolveStyleProviderConfig({ user: params.client, service: getServiceClient(), workspaceId: params.workspaceId });
  const images = await Promise.all(params.imageUrls.map(loadImage));
  let rawText = "";

  if (config.provider === "google") {
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: params.userMessage }];
    for (const image of images) parts.push({ inlineData: { mimeType: image.mimeType, data: image.buffer.toString("base64") } });
    const body = await withProviderRetry(
      { attempts: 3, baseDelayMs: 1000, timeoutMs: 150_000 },
      async (signal) => {
        const response = await fetch(`${GOOGLE_BASE}/v1beta/models/${config.model}:generateContent`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: params.systemPrompt }] },
            contents: [{ role: "user", parts }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
          }),
        });
        const responseBody = await response.text();
        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          const retryAfterMs = retryAfter == null ? null : Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
          if (response.status === 408 || response.status === 429 || response.status >= 500) {
            throw new RetryableHttpError(response.status, responseBody, retryAfterMs);
          }
          throw new StyleError("STYLE_ANALYSIS_FAILED", `Vision action failed (${response.status})`);
        }
        return JSON.parse(responseBody) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      },
    ).catch((error: unknown) => {
      if (error instanceof RetryableHttpError) throw new StyleError("STYLE_ANALYSIS_FAILED", `Vision action failed (${error.status})`);
      if (error instanceof StyleError) throw error;
      throw new StyleError("STYLE_ANALYSIS_FAILED", `Vision action failed: ${error instanceof Error ? error.message : "network failure"}`);
    });
    rawText = body.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text ?? "";
  } else {
    const openai = new OpenAI({ apiKey: config.apiKey, timeout: 150_000, maxRetries: 2 });
    const completion = await openai.chat.completions.create({
      model: config.model,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: [
          { type: "text", text: params.userMessage },
          ...images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}` } })),
        ] },
      ],
    });
    rawText = completion.choices[0]?.message?.content ?? "";
  }

  if (!rawText) throw new StyleError("STYLE_ANALYSIS_FAILED", "Vision action returned no content");
  try {
    return JSON.parse(stripMarkdownFence(rawText));
  } catch {
    throw new StyleError("STYLE_ANALYSIS_UNPARSED", "Vision action returned invalid JSON");
  }
}
