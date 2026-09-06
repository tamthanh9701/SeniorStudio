import { z } from "zod";

export const AI_JOBS_TABLE = "ai_jobs";
export const AI_JOB_INPUTS_TABLE = "ai_job_inputs";

export const AiOperationSchema = z.enum(["text_to_image", "inpaint"]);
export const AiProviderSchema = z.enum(["openai", "google"]);
export const SupportedModelIdSchema = z.string().regex(/^(openai\/gpt-image-2|google\/[a-z0-9._-]+)$/);
export const AiJobStatusSchema = z.enum([
  "queued", "submitting", "processing", "persisting", "succeeded", "failed", "canceled",
]);
export const SupportedSizeSchema = z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]);
export const SupportedQualitySchema = z.enum(["low", "medium", "high", "auto"]);
export const GenerationCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export type AiOperation = z.infer<typeof AiOperationSchema>;
export type AiProvider = z.infer<typeof AiProviderSchema>;
export type SupportedModelId = z.infer<typeof SupportedModelIdSchema>;
export type AiJobStatus = z.infer<typeof AiJobStatusSchema>;
export type SupportedSize = z.infer<typeof SupportedSizeSchema>;
export type SupportedQuality = z.infer<typeof SupportedQualitySchema>;

export const AiJobInputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  count: GenerationCountSchema,
  size: SupportedSizeSchema,
  quality: SupportedQualitySchema,
  mask_storage_path: z.string().nullable().optional(),
  style_id: z.string().uuid().nullable().optional(),
  original_prompt: z.string().nullable().optional(),
});

export const AiJobResultSchema = z.object({ asset_id: z.string().uuid(), version_id: z.string().uuid() });
export const AiJobSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), project_id: z.string().uuid(), requested_by: z.string().uuid(),
  asset_id: z.string().uuid().nullable(), parent_version_id: z.string().uuid().nullable(), version_id: z.string().uuid().nullable(),
  operation: AiOperationSchema, provider: AiProviderSchema, model: SupportedModelIdSchema, status: AiJobStatusSchema,
  attempt_count: z.number().int().nonnegative(), lease_owner: z.string().nullable(), lease_expires_at: z.string().nullable(),
  provider_request_id: z.string().nullable(), provider_status: z.string().nullable(), input: AiJobInputSchema,
  output: z.record(z.string(), z.unknown()), error_code: z.string().nullable(), error_message: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), completed_at: z.string().nullable(),
});
export type AiJob = z.infer<typeof AiJobSchema>;

export const ProjectJobFeedItemSchema = z.object({
  job: AiJobSchema,
  result_urls: z.array(z.string().url()),
});
export type ProjectJobFeedItem = z.infer<typeof ProjectJobFeedItemSchema>;

export const TextToImageEnqueueSchema = z.object({
  operation: z.literal("text_to_image"), model: SupportedModelIdSchema, prompt: z.string().trim().min(1).max(8000),
  count: GenerationCountSchema, size: SupportedSizeSchema, quality: SupportedQualitySchema,
  styleId: z.string().uuid().optional(),
});
export const InpaintEnqueueSchema = z.object({
  operation: z.literal("inpaint"), model: SupportedModelIdSchema, parentVersionId: z.string().uuid(), maskId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8000), quality: SupportedQualitySchema,
});
export const MaskUploadSchema = z.object({ parentVersionId: z.string().uuid(), maskPng: z.string().min(1) });
export const AiJobResponseSchema = z.object({ job: AiJobSchema, result_urls: z.array(z.string().url()).optional() });

export function providerForModel(model: SupportedModelId): AiProvider {
  return model.startsWith("openai/") ? "openai" : "google";
}

export function isTerminalStatus(status: AiJobStatus) {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
