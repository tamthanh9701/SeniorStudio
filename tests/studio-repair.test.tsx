// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

vi.mock("@/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  }),
}));

import ProviderSettings from "@/components/studio/ProviderSettings";
import SettingsSurface from "@/components/studio/SettingsSurface";

// jsdom lacks ResizeObserver; MaskEditor needs it even when the canvas engine
// is skipped. Provide a no-op so setup effects do not throw.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  return { promise, resolve, reject };
}

/** ProviderSettings defers its first load by a tick, so a flush crosses a macrotask. */
const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
});

describe("studio repair component regressions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("ProviderSettings shows a global error with Retry and recovers, keeping configured rows", async () => {
    let calls = 0;
    const gate = deferred();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: "LOAD_FAILED" } }), { status: 500 });
      }
      await gate.promise;
      return new Response(JSON.stringify({ providers: [{ provider: "openai", updatedAt: "2026-01-01T00:00:00Z" }] }), { status: 200 });
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ProviderSettings)); });
    await flush();
    expect(host.textContent).toContain("Unable to load provider settings");
    expect(host.textContent).toContain("Retry");

    const retry = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Retry"));
    expect(retry).not.toBeNull();
    act(() => { retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    gate.resolve(null);
    await flush();
    // Configured rows now say what is true: nothing has checked this key yet.
    expect(host.textContent).toContain("Configured · not checked");
    expect(host.textContent).not.toContain("Unable to load provider settings");

    act(() => { root.unmount(); });
    host.remove();
  });

  it("checks a saved provider key and reports the result instead of a placeholder", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/settings/providers" && init?.method === "POST") return new Response(JSON.stringify({ saved: true }), { status: 201 });
      if (url === "/api/settings/providers/validate") return new Response(JSON.stringify({ ok: true, models: 58, imageModels: 4 }), { status: 200 });
      return new Response(JSON.stringify({ providers: [] }), { status: 200 });
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ProviderSettings)); });
    await flush();

    const saveButton = (row: number) => Array.from(host.querySelectorAll("button")).filter((button) => (button.textContent ?? "").includes("Save"))[row];
    const inputs = Array.from(host.querySelectorAll("input"));
    act(() => {
      const input = inputs[1];
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "AIza-test-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { saveButton(1).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();

    expect(seen).toContain("POST /api/settings/providers/validate");
    expect(host.textContent).toContain("Configured · verified · 4 image models");
    expect(host.textContent).toContain("Key verified: 58 models reachable, 4 image models");
    expect(host.textContent).not.toContain("validation pending");

    act(() => { root.unmount(); });
    host.remove();
  });

  it("malformed, non-array providers response surfaces a global load error, not an empty success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ providers: "not-an-array" }), { status: 200 }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ProviderSettings)); });
    await flush();
    expect(host.textContent).toContain("Unable to load provider settings");
    act(() => { root.unmount(); });
    host.remove();
  });

  it("heartbeat fixture components must not call provider mutations; ProviderSettings disables buttons before ready", async () => {
    const gate = deferred();
    vi.spyOn(globalThis, "fetch").mockReturnValue(gate.promise as Promise<Response>);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ProviderSettings)); });
    // While loading, no Save/Remove buttons are rendered yet (not "Not configured" data).
    expect(host.textContent).toContain("Loading provider settings");
    act(() => { root.unmount(); });
    host.remove();
  });
});
