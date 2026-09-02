import { z } from "zod";

export const BATCH_RUNS_TABLE = "batch_runs";
export const BATCH_ITEMS_TABLE = "batch_items";

export const BatchStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "partial"]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const BatchItemStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);
export type BatchItemStatus = z.infer<typeof BatchItemStatusSchema>;

export const BatchRunSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  preset_id: z.string().uuid().nullable(),
  status: BatchStatusSchema,
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
});
export type BatchRun = z.infer<typeof BatchRunSchema>;

export const BatchItemSchema = z.object({
  id: z.string().uuid(),
  batch_run_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  parent_version_id: z.string().uuid().nullable(),
  status: BatchItemStatusSchema,
  ai_job_id: z.string().uuid().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;

export const CreateBatchRunInputSchema = z.object({
  project_id: z.string().uuid(),
  preset_id: z.string().uuid().optional(),
  items: z.array(z.object({
    asset_id: z.string().uuid(),
    parent_version_id: z.string().uuid().optional(),
  })).min(1).max(4),
  concurrency: z.number().min(1).max(2).default(1),
});
