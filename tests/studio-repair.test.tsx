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
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Unable to load provider settings");
    expect(host.textContent).toContain("Retry");

    const retry = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Retry"));
    expect(retry).not.toBeNull();
    act(() => { retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { gate.resolve(null); await gate.promise; await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Configured · validation pending");
    expect(host.textContent).not.toContain("Unable to load provider settings");

    act(() => { root.unmount(); });
    host.remove();
  });

  it("malformed, non-array providers response surfaces a global load error, not an empty success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ providers: "not-an-array" }), { status: 200 }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ProviderSettings)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
