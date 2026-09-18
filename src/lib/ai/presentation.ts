import type { AiJobStatus, SupportedSize } from "@/db/ai-jobs";

export const JOB_STATUS_LABELS: Record<AiJobStatus, string> = {
  queued: "Queued",
  submitting: "Starting",
  processing: "Generating",
  persisting: "Saving",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Canceled",
};

/**
 * Sizes read as the shape a user is choosing, with the pixels they get: "1536x1024"
 * alone says nothing about orientation. The stored value never changes - only its label.
 */
export const SIZE_LABELS: Record<SupportedSize, string> = {
  "1024x1024": "1:1 square (1024×1024)",
  "1536x1024": "3:2 landscape (1536×1024)",
  "1024x1536": "2:3 portrait (1024×1536)",
  auto: "Auto (model chooses)",
};

/** A label for a persisted size value; an unknown value is shown as it is. */
export function sizeLabel(value: string): string {
  return SIZE_LABELS[value as SupportedSize] ?? value;
}

export const JOB_ERROR_MESSAGES: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: "No AI provider is configured for this workspace. Ask an admin to add an API key.",
  INVALID_REQUEST: "Invalid request. Check your prompt or settings and try again.",
  INVALID_MODEL: "This model is no longer supported. Choose a different model and try again.",
  MALFORMED_PROVIDER_OUTPUT: "The provider returned malformed output. Try again, or choose a different model if the issue persists.",
  INVALID_PROVIDER_STATE: "The provider returned an invalid state. Try again, or contact support if the issue persists.",
  JOB_NOT_CANCELABLE: "This job cannot be canceled in its current state.",
  NOT_FOUND: "Resource not found on the provider. Try again or choose a different model.",
  FILE_UNAVAILABLE: "The source file is no longer available on the provider. Try again or generate a new image.",
  FILE_TOO_LARGE: "The file is too large for the provider. Try again with a smaller image.",
  VERSION_CONFLICT: "The image version changed since you started. Reload the page and try again.",
  GENERATION_FAILED: "Could not generate the image. Try again, or choose a different model if the issue persists.",
};

export function jobErrorMessage(code: string | null | undefined): string {
  return JOB_ERROR_MESSAGES[code ?? ""] ?? JOB_ERROR_MESSAGES.GENERATION_FAILED;
}

export const JOB_STATUS_ORDER: readonly AiJobStatus[] = [
  "queued",
  "submitting",
  "processing",
  "persisting",
  "succeeded",
  "failed",
  "canceled",
];
