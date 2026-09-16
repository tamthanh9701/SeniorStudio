// @vitest-environment jsdom
// The transparent export must resolve its plan and show the prompt and cost before it
// spends anything, and it must report what the server said instead of guessing.
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: nav.replace }),
}));

vi.mock("@/supabase/client", () => ({
  createClient: vi.fn(() => ({
    channel: vi.fn(() => ({ on: vi.fn(() => ({ subscribe: vi.fn() })) })),
    removeChannel: vi.fn(),
  })),
}));

vi.mock("@/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  }),
}));

import ExportTransparentDialog from "@/components/style/ExportTransparentDialog";
import type { AiJob } from "@/db/ai-jobs";

const STYLE_ID = "55555555-5555-4555-8555-555555555555";
const ASSET_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const PLAN_HASH = "hash-from-the-plan";
const EXPORT_PROMPT = "Remove the background: keep the same subject, composition and lighting, on a fully transparent background.";
const BILLING = "Your provider bills this as one image generation.";

type Call = { url: string; init?: RequestInit };

const respond = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => body });

function makeJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    project_id: null,
    module: "style",
    requested_by: "44444444-4444-4444-8444-444444444444",
    asset_id: null,
    parent_version_id: null,
    version_id: null,
    operation: "image_to_image",
    provider: "openai",
    model: "openai/gpt-image-2",
    status: "queued",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    provider_request_id: null,
    provider_status: null,
    input: { prompt: EXPORT_PROMPT, count: 1, size: "auto", quality: "auto", background: "transparent" },
    output: {},
    error_code: null,
    error_message: null,
    created_at: "2026-09-16T10:00:00.000Z",
    updated_at: "2026-09-16T10:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

let calls: Call[] = [];
/** What GET /api/ai-jobs/{id} answers once the dialog follows the job it queued. */
let followUpJob: AiJob = makeJob();

function installFetch(enqueueBody: unknown, enqueueOk = true) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/ai-execution-plan") {
      return respond({
        plan: {
          compiledPrompt: "compiled export prompt for openai/gpt-image-2",
          effectiveModelId: "openai/gpt-image-2",
          planHash: PLAN_HASH,
          warnings: [],
          explanation: "One image, transparent background.",
        },
      });
    }
    if (url.startsWith("/api/ai-jobs/")) return respond({ job: followUpJob, result_urls: [] });
    return respond(enqueueBody, enqueueOk);
  }) as unknown as typeof fetch;
}

const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
};

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount(element: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(element);
  });
}

const buttons = (scope: ParentNode) => Array.from(scope.querySelectorAll("button"));

function findButton(scope: ParentNode, label: string) {
  const button = buttons(scope).find((node) => (node.textContent ?? "").includes(label));
  expect(button, `${label} button`).toBeTruthy();
  return button!;
}

const click = async (scope: ParentNode, label: string) => {
  act(() => {
    findButton(scope, label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

const bodyText = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  followUpJob = makeJob();
  installFetch({ job: makeJob() });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ExportTransparentDialog", () => {
  it("resolves the plan with a transparent background and shows it before spending", async () => {
    mount(createElement(ExportTransparentDialog, { styleId: STYLE_ID, assetId: ASSET_ID, versionId: VERSION_ID }));
    await click(host!, "Export without background");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/ai-execution-plan");
    const request = JSON.parse(String(calls[0].init?.body));
    expect(request).toMatchObject({ operation: "image_to_image", background: "transparent", sourceVersionId: VERSION_ID, styleId: STYLE_ID });

    expect(bodyText()).toContain("openai/gpt-image-2");
    expect(bodyText()).toContain("transparent");
    expect(bodyText()).toContain("compiled export prompt for openai/gpt-image-2");
    expect(bodyText()).toContain(BILLING);
    findButton(document, "Generate without background");
  });

  it("enqueues with the plan's hash for a style image", async () => {
    mount(createElement(ExportTransparentDialog, { styleId: STYLE_ID, assetId: ASSET_ID, versionId: VERSION_ID }));
    await click(host!, "Export without background");
    await click(document, "Generate without background");

    const enqueue = calls.find((call) => call.url === `/api/styles/${STYLE_ID}/ai-jobs`);
    expect(enqueue, "style enqueue request").toBeTruthy();
    expect(JSON.parse(String(enqueue!.init?.body))).toMatchObject({
      background: "transparent",
      prompt: EXPORT_PROMPT,
      sourceVersionId: VERSION_ID,
      consent: { planHash: PLAN_HASH },
    });
    expect(bodyText()).toContain("Generating without a background");
  });

  it("enqueues a project export through the asset route", async () => {
    mount(createElement(ExportTransparentDialog, { assetId: ASSET_ID, versionId: VERSION_ID }));
    await click(host!, "Export without background");
    await click(document, "Generate without background");

    const enqueue = calls.find((call) => call.url === `/api/assets/${ASSET_ID}/ai-jobs`);
    expect(enqueue, "asset enqueue request").toBeTruthy();
    expect(JSON.parse(String(enqueue!.init?.body))).toMatchObject({ background: "transparent", prompt: EXPORT_PROMPT });
    expect(calls.some((call) => call.url.startsWith("/api/styles/"))).toBe(false);
  });

  it("shows the server's refusal instead of a success state", async () => {
    installFetch({ error: { code: "PLAN_CONSENT_MISMATCH", message: "The style changed" } }, false);
    mount(createElement(ExportTransparentDialog, { styleId: STYLE_ID, assetId: ASSET_ID, versionId: VERSION_ID }));
    await click(host!, "Export without background");
    await click(document, "Generate without background");

    expect(bodyText()).toContain("PLAN_CONSENT_MISMATCH: The style changed");
    expect(bodyText()).not.toContain("Done.");
  });

  it("reports the finished export from the job route", async () => {
    followUpJob = makeJob({ status: "succeeded", version_id: VERSION_ID, completed_at: "2026-09-16T10:01:00.000Z", updated_at: "2026-09-16T10:01:00.000Z" });
    mount(createElement(ExportTransparentDialog, { styleId: STYLE_ID, assetId: ASSET_ID, versionId: VERSION_ID }));
    await click(host!, "Export without background");
    await click(document, "Generate without background");

    // The realtime channel is not subscribed in jsdom, so the hook falls back to
    // polling the job route after three seconds.
    await flush(3_400);
    expect(calls.some((call) => call.url === `/api/ai-jobs/${makeJob().id}`)).toBe(true);
    expect(bodyText()).toContain("Done. Keep the candidate version to make it this image's current version.");
  });
});
