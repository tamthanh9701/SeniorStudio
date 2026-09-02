import type { AiJobStatus } from "@/db/ai-jobs";

export const JOB_STATUS_LABELS: Record<AiJobStatus, string> = {
  queued: "In queue",
  submitting: "Starting",
  processing: "Generating",
  persisting: "Saving",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Canceled",
};

export const JOB_STATUS_ORDER: readonly AiJobStatus[] = [
  "queued",
  "submitting",
  "processing",
  "persisting",
  "succeeded",
  "failed",
  "canceled",
];
