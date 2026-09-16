// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const harness = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  fake: { client: undefined as unknown },
}));

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  useRouter: () => ({ replace: harness.replace, refresh: harness.refresh, push: harness.push }),
}));
vi.mock("@/supabase/server", () => ({ createClient: async () => harness.fake.client }));
vi.mock("@/lib/assets/service", () => ({
  getSignedUrl: async (_client: unknown, path: string) => {
    if (path.startsWith("missing")) throw new Error("signing failed");
    return `/signed/${path}`;
  },
}));

import ComparisonSlider from "@/components/editor/ComparisonSlider";
import VersionReviewActions from "@/components/editor/VersionReviewActions";
import StyleAssetDetailPage from "@/app/style/[styleId]/assets/[assetId]/page";

// jsdom has no pointer capture; the slider only needs the calls to not throw.
for (const method of ["setPointerCapture", "releasePointerCapture"]) (Element.prototype as unknown as Record<string, unknown>)[method] = function () {};
(Element.prototype as unknown as Record<string, unknown>).hasPointerCapture = function () { return true; };

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

const mount = (element: ReactElement) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(element); });
  return { host, root };
};

const clickButton = async (host: HTMLElement, label: string) => {
  const button = Array.from(host.querySelectorAll("button")).find((node) => (node.textContent ?? "").includes(label));
  expect(button, `${label} button`).toBeTruthy();
  act(() => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

describe("comparison slider", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("keeps the Parent/Current defaults and still moves by keyboard", () => {
    const { host, root } = mount(createElement(ComparisonSlider, { beforeUrl: "/a.png", afterUrl: "/b.png", width: 100, height: 100 }));
    expect(host.textContent).toContain("Parent");
    expect(host.textContent).toContain("Current");
    const slider = host.querySelector('[role="slider"]')!;
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    act(() => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(slider.getAttribute("aria-valuenow")).toBe("52");
    act(() => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    act(() => { root.unmount(); });
    host.remove();
  });

  it("renders supplied labels and still drags with the pointer", () => {
    const { host, root } = mount(createElement(ComparisonSlider, { beforeUrl: "/a.png", afterUrl: "/b.png", width: 100, height: 100, beforeLabel: "Original", afterLabel: "Edited" }));
    expect(host.textContent).toContain("Original");
    expect(host.textContent).toContain("Edited");
    expect(host.textContent).not.toContain("Parent");
    const stage = host.firstElementChild as HTMLElement;
    stage.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    act(() => { stage.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, pointerId: 1, bubbles: true })); });
    expect(host.querySelector('[role="slider"]')!.getAttribute("aria-valuenow")).toBe("75");
    act(() => { root.unmount(); });
    host.remove();
  });
});

describe("version review actions", () => {
  beforeEach(() => { document.body.innerHTML = ""; harness.replace.mockClear(); harness.refresh.mockClear(); vi.restoreAllMocks(); });

  const mountActions = () => mount(createElement(VersionReviewActions, { assetId: "a1", assetHref: "/style/s1/assets/a1", versionId: "v2", currentVersionId: "v1" }));

  it("keeps the candidate with a compare-and-swap against the observed current", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const { host, root } = mountActions();
    expect(host.textContent).toContain("Discard leaves the current version unchanged. The unselected version remains in history.");
    expect(host.querySelector("a")!.getAttribute("href")).toBe("/style/s1/assets/a1?version=v1&review=1");
    await clickButton(host, "Keep edit");
    expect(fetchSpy).toHaveBeenCalledWith("/api/assets/a1/current", expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({ versionId: "v2", expectedCurrentVersionId: "v1" });
    expect(harness.replace).toHaveBeenCalledWith("/style/s1/assets/a1?version=v2&review=1");
    expect(harness.refresh).toHaveBeenCalled();
    act(() => { root.unmount(); });
    host.remove();
  });

  it("reports a conflict with a reload action instead of retrying on its own", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "Another version was selected first; reload to see the current one" } }), { status: 409 }));
    const { host, root } = mountActions();
    await clickButton(host, "Keep edit");
    expect(host.textContent).toContain("Another version was selected first");
    expect(harness.replace).not.toHaveBeenCalled();
    await clickButton(host, "Reload");
    expect(harness.refresh).toHaveBeenCalled();
    expect(host.textContent).not.toContain("Another version was selected first");
    act(() => { root.unmount(); });
    host.remove();
  });

  it("surfaces a server failure without claiming the edit was kept", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Version not found" } }), { status: 404 }));
    const { host, root } = mountActions();
    await clickButton(host, "Keep edit");
    expect(host.textContent).toContain("Version not found");
    expect(harness.replace).not.toHaveBeenCalled();
    act(() => { root.unmount(); });
    host.remove();
  });
});

describe("style asset review page", () => {
  const version = (id: string, overrides: Row = {}): Row => ({
    id,
    asset_id: "a1",
    storage_path: `assets/a1/${id}.png`,
    width: 1024,
    height: 1024,
    prompt: `prompt ${id}`,
    parent_version_id: null,
    metadata: {},
    style_generation: null,
    source: "web_openai",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  const client = (tables: Record<string, Row[]>) => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1", email: "qa@example.com" } }, error: null }) },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const resolve = () => (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        order: () => builder,
        single: async () => { const rows = resolve(); return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "no rows" } }; },
        maybeSingle: async () => ({ data: resolve()[0] ?? null, error: null }),
        then: (onFulfilled?: (value: unknown) => unknown) => Promise.resolve({ data: resolve(), error: null }).then(onFulfilled),
      };
      return builder;
    },
  });

  const render = async (tables: Record<string, Row[]>, searchParams: { version?: string; review?: string } = {}) => {
    harness.fake.client = client({ styles: [{ id: "s1", name: "Clay Cats" }], ...tables });
    const element = await StyleAssetDetailPage({
      params: Promise.resolve({ styleId: "s1", assetId: "a1" }),
      searchParams: Promise.resolve(searchParams),
    });
    return renderToStaticMarkup(element);
  };

  beforeEach(() => { harness.fake.client = undefined; });

  it("falls back to the current version and says so when the requested version is not on the asset", async () => {
    const markup = await render(
      { assets: [{ id: "a1", name: "Truck", style_id: "s1", current_version_id: "v1", created_at: "2026-01-01T00:00:00.000Z" }], asset_versions: [version("v1")] },
      { version: "88888888-8888-4888-8888-888888888888" },
    );
    expect(markup).toContain("That version is not part of this asset. Showing the current version instead.");
    expect(markup).toContain("/signed/assets/a1/v1.png");
  });

  it("compares a candidate against its exact cross-asset parent and shows review actions plus provenance", async () => {
    const parentId = "11111111-1111-4111-8111-111111111111";
    const parent = version(parentId, {
      asset_id: "a0",
      metadata: { provider: "openai", model: "openai/gpt-image-2", operation: "inpaint", source_asset_id: "a0", source_version_id: parentId },
      style_generation: { style_revision: "rev-1234", reference_snapshot: [{ id: "r1", content_hash: "h" }, { id: "r2", content_hash: "h" }] },
    });
    const child = version("v2", {
      parent_version_id: parentId,
      metadata: { provider: "openai", model: "openai/gpt-image-2", operation: "inpaint", source_asset_id: "a0", source_version_id: parentId },
      style_generation: { style_revision: "rev-1234", reference_snapshot: [{ id: "r1", content_hash: "h" }, { id: "r2", content_hash: "h" }] },
    });
    const markup = await render(
      {
        assets: [
          { id: "a1", name: "Truck", style_id: "s1", current_version_id: "v1", created_at: "2026-01-01T00:00:00.000Z" },
          { id: "a0", name: "Source", style_id: "s1", current_version_id: parentId, created_at: "2026-01-01T00:00:00.000Z" },
        ],
        asset_versions: [parent, child],
      },
      { version: "v2", review: "1" },
    );
    expect(markup).toContain(">Original<");
    expect(markup).toContain(">Edited<");
    expect(markup).toContain("Review edit");
    expect(markup).toContain("Keep edit");
    expect(markup).toContain("Discard");
    expect(markup).toContain("The unselected version remains in history.");
    expect(markup).toContain("openai/gpt-image-2");
    expect(markup).toContain("inpaint");
    expect(markup).toContain("2 used");
    expect(markup).toContain(`/style/s1/assets/a0?version=${parentId}`);
  });

  it("disables comparison and explains when the parent cannot be resolved", async () => {
    const markup = await render(
      {
        assets: [{ id: "a1", name: "Truck", style_id: "s1", current_version_id: "v2", created_at: "2026-01-01T00:00:00.000Z" }],
        asset_versions: [version("v2", { parent_version_id: "99999999-9999-4999-8999-999999999999" })],
      },
      { version: "v2" },
    );
    expect(markup).toContain("The parent version recorded for this edit is no longer available, so the comparison is disabled.");
    expect(markup).not.toContain(">Original<");
    expect(markup).not.toContain("Review edit");
  });

  it("explains when the parent preview cannot be signed", async () => {
    const markup = await render(
      {
        assets: [{ id: "a1", name: "Truck", style_id: "s1", current_version_id: "v2", created_at: "2026-01-01T00:00:00.000Z" }],
        asset_versions: [version("v1", { storage_path: "missing/v1.png" }), version("v2", { parent_version_id: "v1" })],
      },
      { version: "v2" },
    );
    expect(markup).toContain("The parent version preview could not be loaded, so the comparison is disabled.");
    expect(markup).not.toContain(">Original<");
  });

  it("explains that an original version has nothing to compare against", async () => {
    const markup = await render({
      assets: [{ id: "a1", name: "Truck", style_id: "s1", current_version_id: "v1", created_at: "2026-01-01T00:00:00.000Z" }],
      asset_versions: [version("v1", { source: "upload" })],
    });
    expect(markup).toContain("This version has no parent version, so there is nothing to compare it against.");
    expect(markup).not.toContain("Review edit");
  });

  it("confirms that discarding left the current version selected", async () => {
    const markup = await render(
      {
        assets: [{ id: "a1", name: "Truck", style_id: "s1", current_version_id: "v1", created_at: "2026-01-01T00:00:00.000Z" }],
        asset_versions: [version("v1"), version("v2", { parent_version_id: "v1" })],
      },
      { version: "v1", review: "1" },
    );
    expect(markup).toContain("You are viewing the current version. The unselected version remains in history.");
    expect(markup).not.toContain("Keep edit");
  });
});
