import { z } from "zod";

/** Feed page size: one screen of history, shared by the route and the SSR seed. */
export const FEED_LIMIT = 25;

/**
 * Columns a job feed needs. `style_generation` is deliberately absent: ~6 KB per
 * job of provenance that no client code reads (the composer takes its provenance
 * from the version row server-side).
 */
export const FEED_COLUMNS =
  "id, workspace_id, project_id, module, requested_by, asset_id, parent_version_id, version_id, source_version_id, operation, provider, model, status, attempt_count, lease_owner, lease_expires_at, provider_request_id, provider_status, input, output, error_code, error_message, created_at, updated_at, completed_at, style_id";

export const AI_JOBS_TABLE = "ai_jobs";
export const AI_JOB_INPUTS_TABLE = "ai_job_inputs";

export const AiProviderSchema = z.enum(["openai", "google"]);
export const AiOperationSchema = z.enum(["text_to_image", "image_to_image", "inpaint"]);
// Shape only: the catalog decides what a workspace may pick, `public.is_supported_model`
// decides what the enqueue RPCs accept, and the provider rejects an unknown id loudly.
export const SupportedModelIdSchema = z.string().regex(/^(openai|google)\/[a-z0-9._-]+$/);
export const AiJobStatusSchema = z.enum([
  "queued", "submitting", "processing", "persisting", "succeeded", "failed", "canceled",
]);
export const SupportedSizeSchema = z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]);
export const SupportedQualitySchema = z.enum(["low", "medium", "high", "auto"]);
export const GenerationCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const CostModeSchema = z.enum(["strict_style", "strict_1000", "balanced", "quality"]);

export type AiProvider = z.infer<typeof AiProviderSchema>;
export type AiOperation = z.infer<typeof AiOperationSchema>;
export type SupportedModelId = z.infer<typeof SupportedModelIdSchema>;
export type AiJobStatus = z.infer<typeof AiJobStatusSchema>;
export type SupportedSize = z.infer<typeof SupportedSizeSchema>;
export type SupportedQuality = z.infer<typeof SupportedQualitySchema>;
export type CostMode = z.infer<typeof CostModeSchema>;

export const AiJobInputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  count: GenerationCountSchema,
  size: SupportedSizeSchema,
  quality: SupportedQualitySchema,
  mask_storage_path: z.string().nullable().optional(),
  style_id: z.string().uuid().nullable().optional(),
  original_prompt: z.string().nullable().optional(),
  cost_mode: CostModeSchema.optional(),
  source_version_id: z.string().uuid().nullable().optional(),
  requested_model_id: z.string().nullable().optional(),
  reference_ids: z.array(z.string().uuid()).optional().default([]).optional(),
  temperature: z.number().nullable().optional(),
  mask_id: z.string().uuid().nullable().optional(),
  edit_target: z.string().nullable().optional(),
  /** Set when the provider must return the subject on a transparent background. */
  background: z.literal("transparent").nullable().optional(),
  /**
   * Set for Game UI jobs, written by the enqueue RPC from the version 2 packet:
   * enough routing data for a feed entry without carrying the whole packet.
   */
  game_ui: z
    .object({
      intent: z.enum(["screen", "element_reconstruction"]),
      screen_id: z.string().uuid(),
      render_id: z.string().uuid().optional(),
      element_set_id: z.string().uuid().optional(),
      element_id: z.string().uuid().optional(),
    })
    .optional(),
});

export const AiJobModuleSchema = z.enum(["projects", "style"]);
export const AiJobResultSchema = z.object({ asset_id: z.string().uuid(), version_id: z.string().uuid() });
export const AiJobSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), project_id: z.string().uuid().nullable(), module: AiJobModuleSchema.default("projects"), requested_by: z.string().uuid(),
  asset_id: z.string().uuid().nullable(), parent_version_id: z.string().uuid().nullable(), version_id: z.string().uuid().nullable(),
  source_version_id: z.string().uuid().nullable().optional(),
  operation: AiOperationSchema, provider: AiProviderSchema, model: SupportedModelIdSchema, status: AiJobStatusSchema,
  attempt_count: z.number().int().nonnegative(), lease_owner: z.string().nullable(), lease_expires_at: z.string().nullable(),
  provider_request_id: z.string().nullable(), provider_status: z.string().nullable(), input: AiJobInputSchema,
  output: z.record(z.string(), z.unknown()), error_code: z.string().nullable(), error_message: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), completed_at: z.string().nullable(),
  style_id: z.string().uuid().nullable().optional(),
  style_generation: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type AiJob = z.infer<typeof AiJobSchema>;

export const ProjectJobFeedItemSchema = z.object({
  job: AiJobSchema,
  result_urls: z.array(z.string().url()),
});
export type ProjectJobFeedItem = z.infer<typeof ProjectJobFeedItemSchema>;

// Project generation takes no style: a style is applied only in the Style
// module, from its confirmed definition plus reference images.
export const TextToImageEnqueueSchema = z.object({
  operation: z.literal("text_to_image"), model: SupportedModelIdSchema, prompt: z.string().trim().min(1).max(8000),
  count: GenerationCountSchema, size: SupportedSizeSchema, quality: SupportedQualitySchema,
  costMode: CostModeSchema.default("strict_1000"),
  requestedModelId: SupportedModelIdSchema.optional(),
  confirmedModelId: SupportedModelIdSchema.optional(),
  referenceIds: z.array(z.string().uuid()).default([]),
});
export const ImageToImageEnqueueSchema = z.object({
  operation: z.literal("image_to_image"), model: SupportedModelIdSchema,
  prompt: z.string().trim().min(1).max(8000).optional(),
  size: SupportedSizeSchema, quality: SupportedQualitySchema,
  styleId: z.string().uuid(), sourceVersionId: z.string().uuid(),
  costMode: CostModeSchema.default("strict_1000"),
  requestedModelId: SupportedModelIdSchema.optional(),
  confirmedModelId: SupportedModelIdSchema.optional(),
  referenceIds: z.array(z.string().uuid()).default([]),
});
// A project variation: the project module never applies a style, so this is the
// plain image-to-image edit, optionally asking for a transparent background.
export const ProjectVariationEnqueueSchema = z.object({
  operation: z.literal("image_to_image"), model: SupportedModelIdSchema,
  prompt: z.string().trim().min(1).max(8000),
  sourceVersionId: z.string().uuid(),
  count: GenerationCountSchema.default(1), size: SupportedSizeSchema, quality: SupportedQualitySchema,
  costMode: CostModeSchema.default("strict_1000"),
  background: z.literal("transparent").nullable().optional(),
});
export const InpaintEnqueueSchema = z.object({
  operation: z.literal("inpaint"), model: SupportedModelIdSchema, parentVersionId: z.string().uuid(), maskId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8000), quality: SupportedQualitySchema,
  referenceIds: z.array(z.string().uuid()).default([]),
  // Accepted so the API can refuse it explicitly: an edit reuses the references
  // recorded with its source image, so borrowing cannot change what it means.
  libraryReferenceIds: z.array(z.string().uuid()).default([]),
  editTarget: z.string().optional(), consent: z.object({ planHash: z.string().min(1) }).optional(), useCurrentStyle: z.boolean().optional(),
});
export const MaskUploadSchema = z.object({ parentVersionId: z.string().uuid(), maskPng: z.string().min(1) });
export const AiJobResponseSchema = z.object({ job: AiJobSchema, result_urls: z.array(z.string().url()).optional() });

export function providerForModel(model: SupportedModelId): AiProvider {
  return model.startsWith("openai/") ? "openai" : "google";
}

export function isTerminalStatus(status: AiJobStatus) {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
