import { z } from "zod";

export const BrowserOperationSchema = z.enum(["chat", "generate", "edit"]);
export const BrowserJobStatusSchema = z.enum([
  "queued", "claimed", "submitting", "generating", "downloading", "persisting",
  "succeeded", "failed", "needs_login", "needs_review", "canceled",
]);
export const BrowserWorkerStatusSchema = z.enum(["online", "needs_login", "degraded", "offline"]);

export const ChatThreadSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  title: z.string(), provider: z.literal("chatgpt_web"), provider_conversation_url: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
});
export const ChatMessageSchema = z.object({
  id: z.string().uuid(), thread_id: z.string().uuid(), role: z.enum(["user", "assistant"]),
  kind: z.enum(["text", "image"]), content: z.string(), asset_id: z.string().uuid().nullable(),
  version_id: z.string().uuid().nullable(), job_id: z.string().uuid().nullable(), created_at: z.string(),
});
export const BrowserJobSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  thread_id: z.string().uuid(), operation: BrowserOperationSchema, prompt: z.string(),
  parent_version_id: z.string().uuid().nullable(), status: BrowserJobStatusSchema,
  lease_owner: z.string().nullable(), lease_expires_at: z.string().nullable(), attempt_count: z.number().int(),
  asset_id: z.string().uuid().nullable(), version_id: z.string().uuid().nullable(),
  provider_conversation_url: z.string().nullable(), error_code: z.string().nullable(), error_message: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), completed_at: z.string().nullable(),
});
export const BrowserBridgeWorkerSchema = z.object({
  worker_id: z.string(), status: BrowserWorkerStatusSchema, last_seen_at: z.string(),
  active_job_id: z.string().uuid().nullable(), browser_url: z.string().url().nullable(),
  error_code: z.string().nullable(), error_message: z.string().nullable(),
});

export const CreateChatMessageSchema = z.object({
  threadId: z.string().uuid().optional(), mode: BrowserOperationSchema,
  message: z.string().trim().min(1).max(8000), parentVersionId: z.string().uuid().optional(),
}).superRefine((value, context) => {
  if (value.mode === "edit" && !value.parentVersionId) {
    context.addIssue({ code: "custom", path: ["parentVersionId"], message: "Edit mode requires a parent version" });
  }
  if (value.mode !== "edit" && value.parentVersionId) {
    context.addIssue({ code: "custom", path: ["parentVersionId"], message: "Only edit mode accepts a parent version" });
  }
});

export type BrowserOperation = z.infer<typeof BrowserOperationSchema>;
export type BrowserJobStatus = z.infer<typeof BrowserJobStatusSchema>;
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type BrowserJob = z.infer<typeof BrowserJobSchema>;
export type BrowserBridgeWorker = z.infer<typeof BrowserBridgeWorkerSchema>;

export const ACTIVE_JOB_STATUSES: BrowserJobStatus[] = ["queued", "claimed", "submitting", "generating", "downloading", "persisting"];
export const RETRYABLE_JOB_STATUSES: BrowserJobStatus[] = ["failed", "needs_login", "needs_review"];
