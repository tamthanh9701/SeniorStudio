// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiJob, ProjectJobFeedItem } from "@/db/ai-jobs";
import { isTerminalStatus } from "@/db/ai-jobs";

vi.mock("@/supabase/client", () => ({
  createClient: vi.fn(() => ({
    channel: vi.fn(() => ({
      on: vi.fn(() => ({ subscribe: vi.fn() })),
    })),
    removeChannel: vi.fn(),
  })),
}));

vi.mock("@/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  }),
}));

const WS_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

function makeJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: WS_ID,
    project_id: PROJECT_ID,
    module: "projects",
    requested_by: "44444444-4444-4444-8444-444444444444",
    asset_id: null,
    parent_version_id: null,
    version_id: null,
    operation: "text_to_image",
    provider: "google",
    model: "google/gemini-2.5-flash-image",
    status: "queued",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    provider_request_id: null,
    provider_status: null,
    input: { prompt: "test image", count: 1, size: "1024x1024", quality: "auto" },
    output: {},
    error_code: null,
    error_message: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function makeFeedItem(job: AiJob, urls: string[] = []): ProjectJobFeedItem {
  return { job, result_urls: urls };
}

import { reconcileJobFeed } from "@/lib/ai/use-module-jobs";

describe("reconcileJobFeed", () => {
  it("merges snapshot into current, preserves terminal window of 50", () => {
    const terminalJobs: ProjectJobFeedItem[] = Array.from({ length: 55 }, (_, i) =>
      makeFeedItem(makeJob({
        id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        status: "succeeded",
        updated_at: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        created_at: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      }))
    );
    const result = reconcileJobFeed(terminalJobs, []);
    const terminalCount = result.filter((item: ProjectJobFeedItem) => isTerminalStatus(item.job.status)).length;
    expect(terminalCount).toBeLessThanOrEqual(50);
  });

  it("prefers incoming URLs when version IDs match", () => {
    const vId = "77777777-7777-4777-8777-777777777777";
    const job = makeJob({
      status: "succeeded",
      output: { results: [{ asset_id: "a", version_id: vId }] },
    });
    const current = makeFeedItem(job, ["https://old.url"]);
    const incoming = makeFeedItem(
      makeJob({ updated_at: "2026-01-01T00:01:00.000Z", status: "succeeded", output: { results: [{ asset_id: "a", version_id: vId }] } }),
      ["https://new.url"]
    );
    const result = reconcileJobFeed([current], [incoming]);
    expect(result[0].result_urls).toEqual(["https://new.url"]);
  });

  it("clears URLs when identity changed (different version IDs)", () => {
    const job1 = makeJob({
      id: "22222222-2222-4222-8222-222222222222",
      status: "succeeded",
      output: { results: [{ asset_id: "a", version_id: "v1" }] },
      updated_at: "2026-01-01T00:01:00.000Z",
    });
    const job2 = makeJob({
      id: "22222222-2222-4222-8222-222222222222",
      status: "succeeded",
      output: { results: [{ asset_id: "a", version_id: "v2" }] },
      updated_at: "2026-01-01T00:02:00.000Z",
    });
    const current = makeFeedItem(job1, ["https://old.url"]);
    const incoming = makeFeedItem(job2, []);
    const result = reconcileJobFeed([current], [incoming]);
    expect(result[0].result_urls).toEqual([]);
  });
});
