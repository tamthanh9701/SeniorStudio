import { describe, expect, it } from "vitest";
import { CreateProjectSchema } from "@/app/api/projects/route";
import { AiJobStatusSchema, type AiJob } from "@/db/ai-jobs";
import { JOB_STATUS_LABELS } from "@/lib/ai/presentation";
import { mergeProjectJob } from "@/lib/ai/use-project-jobs";

const job = (overrides: Partial<AiJob> = {}): AiJob => ({
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: "33333333-3333-4333-8333-333333333333",
  requested_by: "44444444-4444-4444-8444-444444444444",
  asset_id: null, parent_version_id: null, version_id: null,
  operation: "text_to_image", provider: "google", model: "google/gemini-2.5-flash-image", status: "queued",
  attempt_count: 0, lease_owner: null, lease_expires_at: null, provider_request_id: null, provider_status: null,
  input: { prompt: "test image", count: 1, size: "1024x1024", quality: "auto" }, output: {},
  error_code: null, error_message: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", completed_at: null,
  ...overrides,
});

describe("project creation validation", () => {
  it("trims valid names and rejects empty or oversized names", () => {
    expect(CreateProjectSchema.parse({ name: "  Portraits  " }).name).toBe("Portraits");
    expect(CreateProjectSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(CreateProjectSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});

describe("project job feed updates", () => {
  it("appends inserts and replaces updates without duplicates", () => {
    const queued = job();
    const initial = mergeProjectJob([], queued);
    const succeeded = job({ status: "succeeded", output: { results: [] } });
    const updated = mergeProjectJob(initial, succeeded);
    expect(updated).toHaveLength(1);
    expect(updated[0].job.status).toBe("succeeded");
  });
});

describe("job presentation", () => {
  it("covers all persisted statuses with human labels", () => {
    for (const status of AiJobStatusSchema.options) expect(JOB_STATUS_LABELS[status]).toBeTruthy();
    expect(Object.keys(JOB_STATUS_LABELS)).toHaveLength(7);
  });
});
