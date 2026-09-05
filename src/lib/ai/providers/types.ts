import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiJob } from "@/db/ai-jobs";

export type ProviderImage =
  | { kind: "bytes"; bytes: Uint8Array; contentType: string }
  | { kind: "url"; url: string; contentType?: string };

export type ProviderSubmission =
  | { state: "completed"; images: ProviderImage[]; requestId: string | null; metadata: Record<string, unknown> }
  | { state: "processing"; requestId: string; providerStatus: string; metadata: Record<string, unknown> };

export type ProviderPollResult =
  | { state: "processing"; providerStatus: string; metadata: Record<string, unknown> }
  | { state: "completed"; images: ProviderImage[]; providerStatus: string; metadata: Record<string, unknown> };

export type ProviderContext = { client: SupabaseClient; job: AiJob; apiKey: string };

export interface ImageProvider {
  submit(context: ProviderContext): Promise<ProviderSubmission>;
  poll(context: ProviderContext): Promise<ProviderPollResult>;
  cancel(context: ProviderContext): Promise<void>;
}

export class ProviderError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
