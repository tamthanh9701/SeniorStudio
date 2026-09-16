// @vitest-environment jsdom
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: nav.replace }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

vi.mock("@/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  }),
}));

import StylePanel from "@/components/studio/StylePanel";
import StyleWorkspace from "@/components/studio/StyleWorkspace";
import { createEmptyPrompt } from "@/lib/style/prompt-schema";
import type { ModelCatalogEntry } from "@/lib/ai/models";

const STYLE_ID = "55555555-5555-4555-8555-555555555555";
const CONFIRMED_REF = "22222222-2222-4222-8222-222222222222";
const LIVE_REF = "33333333-3333-4333-8333-333333333333";
const CONTENT_HASH = "a".repeat(64);

type Row = Record<string, unknown>;
type Call = { url: string; init?: RequestInit };

const respond = (body: unknown, ok = true) => ({ ok, json: async () => body });

function installFetch(handler: (url: string, init: RequestInit | undefined) => unknown) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

function liveReference(id: string) {
  return {
    id,
    mime_type: "image/png",
    byte_size: 1024,
    width: 64,
    height: 64,
    content_hash: CONTENT_HASH,
    created_at: "2026-09-01T00:00:00.000Z",
    signed_url: `https://test.supabase.co/signed/${id}.png`,
  };
}

function alertStyleRow(overrides: Row = {}): Row {
  return {
    id: STYLE_ID,
    name: "Clay Cats",
    status: "draft",
    schema: null,
    invariant_contract: null,
    analysis_meta: null,
    confirmed_definition: null,
    updated_at: "2026-09-01T00:00:00.000Z",
    references: [],
    schemaVersions: [],
    ...overrides,
  };
}

function analyzedRow(referenceId: string, overrides: Row = {}): Row {
  return alertStyleRow({
    schema: createEmptyPrompt("Clay Cats"),
    analysis_meta: {
      analyzedAt: "2026-09-02T00:00:00.000Z",
      reference_snapshot: [{ id: referenceId, content_hash: CONTENT_HASH }],
    },
    references: [liveReference(referenceId)],
    ...overrides,
  });
}

function confirmedDefinition(referenceId: string) {
  return {
    definition_version: 1,
    style_revision: "99999999-9999-4999-8999-999999999999",
    schema_snapshot: createEmptyPrompt("Clay Cats"),
    reference_snapshot: [{ id: referenceId, content_hash: CONTENT_HASH }],
    confirmed_at: "2026-09-03T00:00:00.000Z",
  };
}

const MODELS = [{
  id: "openai/gpt-image-2",
  label: "OpenAI GPT Image 2",
  provider: "openai",
  operations: ["text_to_image", "image_to_image"],
  sizes: ["1024x1024"],
  qualities: ["auto"],
  maxCount: 4,
}] as unknown as ModelCatalogEntry[];

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

const findButton = (host: HTMLElement, label: string) => {
  const button = Array.from(host.querySelectorAll("button")).find((node) => (node.textContent ?? "").includes(label));
  expect(button, `${label} button`).toBeTruthy();
  return button!;
};

const clickButton = async (host: HTMLElement, label: string) => {
  act(() => { findButton(host, label).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const uploadFiles = async (host: HTMLElement, files: File[]) => {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files });
  act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
};

beforeEach(() => {
  document.body.innerHTML = "";
  nav.push.mockClear();
  nav.refresh.mockClear();
  vi.restoreAllMocks();
});

describe("style list", () => {
  it("shows setup status in plain words and links each card to its style", async () => {
    installFetch(async (url) => {
      if (url.startsWith("/api/styles/libraries")) return respond({ libraries: [] });
      return respond({
        styles: [
          { id: "s1", name: "Draft style", status: "draft", referenceCount: 0, imageCount: 0, thumbnailUrl: null, updatedAt: "2026-01-01", libraryId: null, setupState: "references", operability: { score: 12, grade: "not_ready" } },
          { id: "s2", name: "Ready style", status: "active", referenceCount: 3, imageCount: 4, thumbnailUrl: null, updatedAt: "2026-01-01", libraryId: null, setupState: "ready", operability: { score: 96, grade: "production_ready" } },
        ],
      });
    });
    const { host, root } = mount(createElement(StylePanel));
    await flush();

    expect(host.textContent).toContain("Needs reference images");
    expect(host.textContent).toContain("Confirmed and ready");
    expect(host.textContent).toContain("4 images · 3 references");
    expect(host.textContent).toContain("0 images · 0 references");
    expect(host.textContent).not.toContain("production_ready");
    expect(host.textContent).not.toContain("96/100");

    const links = Array.from(host.querySelectorAll("a"));
    expect(links.find((link) => link.textContent?.includes("Draft style"))?.getAttribute("href")).toBe("/style/s1");
    expect(links.find((link) => link.textContent?.includes("Ready style"))?.getAttribute("href")).toBe("/style/s2");
    unmount(host, root);
  });

  it("opens the new style on its references step after creation", async () => {
    installFetch(async (url, init) => {
      if (url === "/api/styles" && init?.method === "POST") return respond({ style: { id: "new-style-id" } });
      return respond({ styles: [], libraries: [] });
    });
    const { host, root } = mount(createElement(StylePanel));
    await flush();

    act(() => { setInputValue(host.querySelector('input[aria-label="New style name"]') as HTMLInputElement, "Fresh style"); });
    await clickButton(host, "Create style");

    expect(nav.push).toHaveBeenCalledWith("/style/new-style-id?tab=references");
    unmount(host, root);
  });
});

describe("style workspace", () => {
  it("shows a retryable error when the style cannot be loaded", async () => {
    installFetch(async () => respond({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, false));
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "references", models: MODELS, initialJobs: [] }));
    await flush();

    expect(host.textContent).toContain("This style could not be loaded");
    expect(host.textContent).toContain("STYLE_NOT_FOUND");

    installFetch(async (url) => (url.includes("/assets") ? respond({ assets: [] }) : respond({ style: alertStyleRow() })));
    await clickButton(host, "Try again");

    expect(host.textContent).toContain("Analyze references");
    expect(findButton(host, "Analyze references").hasAttribute("disabled")).toBe(true);
    unmount(host, root);
  });

  it("refuses files that are not PNG or JPEG before uploading", async () => {
    const calls = installFetch(async (url) => (url.includes("/assets") ? respond({ assets: [] }) : respond({ style: alertStyleRow() })));
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "references", models: MODELS, initialJobs: [] }));
    await flush();

    await uploadFiles(host, [new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" })]);

    expect(host.textContent).toContain("only PNG and JPEG images are supported");
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    unmount(host, root);
  });

  it("retires a reference through the delete endpoint and reloads the list", async () => {
    const state = { references: [liveReference(LIVE_REF)] };
    const calls = installFetch(async (url, init) => {
      if (url.includes("/assets")) return respond({ assets: [] });
      if (init?.method === "DELETE") {
        state.references = [];
        return respond({ ok: true });
      }
      return respond({ style: alertStyleRow({ references: state.references }) });
    });
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "references", models: MODELS, initialJobs: [] }));
    await flush();
    expect(host.querySelectorAll('img[alt="Style reference"]')).toHaveLength(1);

    await clickButton(host, "Remove");

    expect(calls.find((call) => call.init?.method === "DELETE")?.url).toBe(`/api/styles/${STYLE_ID}/references/${LIVE_REF}`);
    expect(host.querySelectorAll('img[alt="Style reference"]')).toHaveLength(0);
    expect(host.textContent).toContain("Reference removed from the editable set");
    unmount(host, root);
  });

  it("keeps accepted files and says so when a batch upload fails partway", async () => {
    const state = { references: [] as Row[] };
    installFetch(async (url, init) => {
      if (url.includes("/assets")) return respond({ assets: [] });
      if (url.includes("/references") && init?.method === "POST") {
        // The API accepts one file and then rejects the batch: accepted rows stay.
        state.references = [liveReference(LIVE_REF)];
        return respond({ error: { code: "TOO_MANY_REFERENCES", message: "A style supports at most 20 reference images" } }, false);
      }
      return respond({ style: alertStyleRow({ references: state.references }) });
    });
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "references", models: MODELS, initialJobs: [] }));
    await flush();

    await uploadFiles(host, [new File([new Uint8Array([1, 2, 3])], "cat.png", { type: "image/png" })]);

    expect(host.textContent).toContain("Files that were already accepted are kept");
    expect(host.querySelectorAll('img[alt="Style reference"]')).toHaveLength(1);
    unmount(host, root);
  });

  it("never confirms a style whose analysis went stale", async () => {
    const calls = installFetch(async (url, init) => {
      if (url.includes("/assets")) return respond({ assets: [] });
      if (init?.method === "PATCH") return respond({ error: { code: "STYLE_ANALYSIS_STALE", message: "References changed since the analysis" } }, false);
      return respond({ style: analyzedRow(LIVE_REF) });
    });
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "style", models: MODELS, initialJobs: [] }));
    await flush();

    await clickButton(host, "Confirm style & continue");

    expect(calls.some((call) => call.init?.method === "PATCH")).toBe(true);
    expect(host.textContent).toContain("The reference set changed after the analysis was run");
    expect(findButton(host, "Analyze references")).toBeTruthy();
    expect(host.textContent).not.toContain("Style guide");
    unmount(host, root);
  });

  it("opens the images tab once the style is confirmed", async () => {
    const state = { style: analyzedRow(LIVE_REF) };
    installFetch(async (url, init) => {
      if (url.includes("/assets")) return respond({ assets: [] });
      if (init?.method === "PATCH") {
        state.style = alertStyleRow({ status: "active", schema: createEmptyPrompt("Clay Cats"), confirmed_definition: confirmedDefinition(LIVE_REF), references: [liveReference(LIVE_REF)] });
        return respond({ style: state.style });
      }
      return respond({ style: state.style });
    });
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "style", models: MODELS, initialJobs: [] }));
    await flush();

    await clickButton(host, "Confirm style & continue");

    expect(host.textContent).toContain("Style guide");
    // The confirmed state is now one compact line: references, when it was
    // confirmed, and the revision in use.
    expect(host.textContent).toMatch(/1 reference · confirmed /);
    expect(host.textContent).toContain("revision 99999999");
    unmount(host, root);
  });

  it("generates from the confirmed reference set even when the editable set changed", async () => {
    installFetch(async (url) => {
      if (url.includes("/assets")) return respond({ assets: [] });
      return respond({
        style: alertStyleRow({
          status: "active",
          schema: createEmptyPrompt("Clay Cats"),
          confirmed_definition: confirmedDefinition(CONFIRMED_REF),
          references: [liveReference(LIVE_REF)],
        }),
      });
    });
    const { host, root } = mount(createElement(StyleWorkspace, { styleId: STYLE_ID, initialTab: "images", models: MODELS, initialJobs: [] }));
    await flush();

    expect(host.textContent).toContain("Style references used");
    expect(host.textContent).toContain("Preview unavailable");
    expect(host.querySelectorAll('img[alt="Style reference"]')).toHaveLength(0);
    unmount(host, root);
  });
});
