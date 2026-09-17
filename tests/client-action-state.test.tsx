// @vitest-environment jsdom
// Throwaway probe for the client-side action-state hardening. Deleted after the run.
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
const params = vi.hoisted(() => ({ current: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: nav.replace }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(params.current),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

vi.mock("@/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn(), signInWithPassword: vi.fn(), resetPasswordForEmail: vi.fn() },
    channel: () => ({ on: () => ({ subscribe: () => undefined }) }),
    removeChannel: () => undefined,
  }),
}));

vi.mock("@/env", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" }),
}));

import ProjectWorkspace from "@/components/studio/ProjectWorkspace";
import StyleWorkspace from "@/components/studio/StyleWorkspace";
import ClarificationForm from "@/components/studio/ClarificationForm";
import SchemaEditor from "@/components/studio/SchemaEditor";
import LoginPage from "@/app/login/page";
import { readTheme, subscribeTheme, writeTheme } from "@/lib/theme/theme-store";
import { createEmptyPrompt } from "@/lib/style/prompt-schema";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { AiJob, ProjectJobFeedItem } from "@/db/ai-jobs";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const STYLE_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "66666666-6666-4666-8666-666666666666";

const MODELS = [{
  id: "openai/gpt-image-2",
  label: "OpenAI GPT Image 2",
  provider: "openai",
  operations: ["text_to_image", "image_to_image"],
  sizes: ["1024x1024"],
  qualities: ["auto"],
  maxCount: 4,
}] as unknown as ModelCatalogEntry[];

function makeJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: JOB_ID,
    workspace_id: "22222222-2222-4222-8222-222222222222",
    project_id: PROJECT_ID,
    module: "projects",
    requested_by: "44444444-4444-4444-8444-444444444444",
    asset_id: null,
    parent_version_id: null,
    version_id: null,
    operation: "text_to_image",
    provider: "openai",
    model: "openai/gpt-image-2",
    status: "queued",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    provider_request_id: null,
    provider_status: null,
    input: { prompt: "a probe", count: 1, size: "1024x1024", quality: "auto" },
    output: {},
    error_code: null,
    error_message: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

const feed = (job: AiJob): ProjectJobFeedItem => ({ job, result_urls: [] });

const flush = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
};

const mount = (element: ReactElement) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(element); });
  return { host, root };
};

const unmount = (host: HTMLElement, root: { unmount: () => void }) => {
  act(() => { root.unmount(); });
  host.remove();
};

const findButton = (host: HTMLElement, label: string) => Array.from(host.querySelectorAll("button")).find((node) => (node.textContent ?? "").includes(label)) ?? null;
const click = async (element: Element | null) => {
  expect(element, "clickable").toBeTruthy();
  act(() => { element!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};
const alertText = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent ?? "";
/** The composer's own button: the inspector also renders a "Generate" toggle. */
const composerButton = (host: HTMLElement, label: string) => {
  const textarea = host.querySelector('textarea[aria-label="Generation prompt"]')!;
  const root = textarea.closest("div.max-w-3xl") as HTMLElement;
  return Array.from(root.querySelectorAll("button")).find((node) => (node.textContent ?? "").includes(label)) ?? null;
};
const setTextarea = (element: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); params.current = ""; });
afterEach(() => { vi.restoreAllMocks(); });

describe("client action state hardening", () => {
  it("project submit reports a thrown request and re-enables the composer", async () => {
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ai-jobs?limit=50")) return { ok: true, json: async () => ({ jobs: [] }) };
      posts += 1;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const { host, root } = mount(createElement(ProjectWorkspace, {
      project: { id: PROJECT_ID, name: "Portraits" },
      projects: [{ id: PROJECT_ID, name: "Portraits" }],
      userEmail: "owner@test",
      assets: [],
      models: MODELS,
      initialJobs: [],
    }));
    await flush();
    act(() => { setTextarea(host.querySelector('textarea[aria-label="Generation prompt"]') as HTMLTextAreaElement, "a probe"); });
    await flush();
    expect(composerButton(host, "Generate")?.disabled).toBe(false);
    await click(composerButton(host, "Generate"));
    expect(posts).toBe(1);
    expect(alertText(host)).toBe("NETWORK_ERROR: Unable to start generation");
    expect(composerButton(host, "Generate")?.disabled).toBe(false);
    unmount(host, root);
  });

  it("project cancel ignores the second click and re-enables the button", async () => {
    const deferred = Promise.withResolvers<{ ok: boolean; json: () => Promise<unknown> }>();
    let cancels = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ai-jobs?limit=50")) return { ok: true, json: async () => ({ jobs: [feed(makeJob())] }) };
      if (url.includes("/cancel")) { cancels += 1; return deferred.promise; }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const { host, root } = mount(createElement(ProjectWorkspace, {
      project: { id: PROJECT_ID, name: "Portraits" },
      projects: [{ id: PROJECT_ID, name: "Portraits" }],
      userEmail: "owner@test",
      assets: [],
      models: MODELS,
      initialJobs: [feed(makeJob())],
    }));
    await flush();
    const cancelButton = findButton(host, "Cancel");
    expect(cancelButton?.disabled).toBe(false);
    act(() => { cancelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    const pending = findButton(host, "Cancel");
    expect(pending?.disabled).toBe(true);
    act(() => { pending!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(cancels).toBe(1);
    deferred.resolve({ ok: true, json: async () => ({ job: makeJob({ status: "canceled", completed_at: "2026-09-01T00:00:01.000Z" }) }) });
    await flush();
    expect(cancels).toBe(1);
    expect(host.textContent).not.toContain("NETWORK_ERROR");
    expect(alertText(host)).toBe("");
    unmount(host, root);
  });

  it("project cancel reports a thrown request", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ai-jobs?limit=50")) return { ok: true, json: async () => ({ jobs: [feed(makeJob())] }) };
      if (url.includes("/cancel")) throw new TypeError("Failed to fetch");
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const { host, root } = mount(createElement(ProjectWorkspace, {
      project: { id: PROJECT_ID, name: "Portraits" },
      projects: [{ id: PROJECT_ID, name: "Portraits" }],
      userEmail: "owner@test",
      assets: [],
      models: MODELS,
      initialJobs: [feed(makeJob())],
    }));
    await flush();
    await click(findButton(host, "Cancel"));
    expect(alertText(host)).toBe("NETWORK_ERROR: Unable to cancel this job");
    expect(findButton(host, "Cancel")?.disabled).toBe(false);
    unmount(host, root);
  });

  it("project asset delete closes the dialog and reports a thrown request", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ai-jobs?limit=50")) return { ok: true, json: async () => ({ jobs: [] }) };
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const { host, root } = mount(createElement(ProjectWorkspace, {
      project: { id: PROJECT_ID, name: "Portraits" },
      projects: [{ id: PROJECT_ID, name: "Portraits" }],
      userEmail: "owner@test",
      assets: [{ id: ASSET_ID, name: "First render", signedUrl: "https://test.supabase.co/signed/a.png", versionId: null, width: 1024, height: 1024, createdAt: "2026-09-01T00:00:00.000Z" }],
      models: MODELS,
      initialJobs: [],
    }));
    await flush();
    await click(host.querySelector('[aria-label="Delete this asset"]'));
    expect(findButton(document.body, "Delete permanently")).toBeTruthy();
    await click(findButton(document.body, "Delete permanently"));
    expect(document.body.textContent).not.toContain("Delete permanently");
    expect(alertText(host)).toBe("NETWORK_ERROR: Unable to delete this asset");
    unmount(host, root);
  });

  it("style cancel reports a thrown request and re-enables the button", async () => {
    const styleRow = {
      id: STYLE_ID, name: "Clay Cats", status: "draft", schema: createEmptyPrompt("Clay Cats"), invariant_contract: null,
      analysis_meta: null, confirmed_definition: null, updated_at: "2026-09-01T00:00:00.000Z", references: [], schemaVersions: [],
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ai-jobs?limit=50")) return { ok: true, json: async () => ({ jobs: [feed(makeJob({ module: "style", project_id: null }))] }) };
      if (url.includes("/cancel")) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({ style: styleRow }) };
    }) as unknown as typeof fetch;
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "images", models: MODELS, initialJobs: [feed(makeJob({ module: "style", project_id: null }))] }));
    await flush();
    await click(findButton(host, "Activity"));
    await click(findButton(host, "Cancel"));
    expect(host.textContent).toContain("NETWORK_ERROR: Unable to cancel this job");
    expect(findButton(host, "Cancel")?.disabled).toBe(false);
    unmount(host, root);
  });

  it("clarification form reports a thrown request", async () => {
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const { host, root } = mount(createElement(ClarificationForm, {
      styleId: STYLE_ID,
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
      questions: { version: "style_clarification_questions_v1", status: "optional_confirmation", questions: [], recommended_next_action: "can_generate_but_user_confirmation_improves_schema" },
      onUpdated: async () => undefined,
    }));
    await click(findButton(host, "Preview synthesis proposal"));
    expect(alertText(host)).toBe("NETWORK_ERROR: Unable to request a synthesis proposal");
    expect(findButton(host, "Preview synthesis proposal")?.disabled).toBe(false);
    unmount(host, root);
  });

  it("schema editor reports a thrown request", async () => {
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const { host, root } = mount(createElement(SchemaEditor, { styleId: STYLE_ID, schema: {}, onSaved: async () => undefined }));
    await click(findButton(host, "Save changes"));
    expect(host.textContent).toContain("NETWORK_ERROR: Unable to save schema");
    expect(findButton(host, "Save changes")?.disabled).toBe(false);
    unmount(host, root);
  });

  it("theme store keeps the written choice when storage is denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readTheme()).toBe("system");
    let notified = 0;
    const unsubscribe = subscribeTheme(() => { notified += 1; });
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
    expect(notified).toBe(1);
    writeTheme("light");
    expect(readTheme()).toBe("light");
    unsubscribe();
  });

  it("login renders the error parameter that useSearchParams already decoded", async () => {
    params.current = "error=%25";
    const { host, root } = mount(createElement(LoginPage));
    await flush();
    expect(alertText(host)).toBe("%");
    expect(host.textContent).toContain("Sign in");
    unmount(host, root);
  });
});
