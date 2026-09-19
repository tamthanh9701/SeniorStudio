// @vitest-environment jsdom
// A pack is only trustworthy if its entries cannot escape the archive, its
// manifest leaks nothing server-side, and every byte is verified against the
// pinned size and hash before a download happens.
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AssetPackExport from "@/components/game-ui/AssetPackExport";
import { GameUiError } from "@/lib/game-ui/errors";
import {
  MANIFEST_VERSION,
  assertPackSelection,
  buildPackManifest,
  packEntryPath,
  type PackManifestInput,
} from "@/lib/game-ui/manifest";
import { buildAssetZip } from "@/lib/game-ui/pack-client";

const STYLE_ID = "11111111-1111-4111-8111-111111111111";
const SCREEN_ID = "22222222-2222-4222-8222-222222222222";
const RENDER_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const SET_ID = "55555555-5555-4555-8555-555555555555";
const ELEMENT_ID = "66666666-6666-4666-8666-666666666666";
const CHILD_ID = "77777777-7777-4777-8777-777777777777";
const OUTPUT_ID = "88888888-8888-4888-8888-888888888888";
const ASSET_ID = "99999999-9999-4999-8999-999999999999";
const VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_OUTPUT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const OTHER_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const PAUSE_PATH = packEntryPath("Pause button", ELEMENT_ID);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const bounds = (x = 0, y = 0, width = 64, height = 32) => ({ x, y, width, height });

function manifestInput(overrides: Partial<PackManifestInput> = {}): PackManifestInput {
  return {
    style: { id: STYLE_ID, revision: "style-revision-1" },
    screen: {
      id: SCREEN_ID,
      renderId: RENDER_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      width: 1280,
      height: 720,
      spec: { schema_version: 1, name: "Battle HUD", requirements: [] },
    },
    elementSet: { id: SET_ID, revision: 3 },
    elements: [
      {
        id: ELEMENT_ID,
        parentId: null,
        kind: "button",
        customType: null,
        name: "Pause button",
        purpose: "Pauses the battle",
        visibleText: "II",
        visibleState: "default",
        bounds: bounds(10, 20, 64, 64),
        zIndex: 2,
        occluded: false,
      },
    ],
    assets: [
      {
        elementId: ELEMENT_ID,
        outputId: OUTPUT_ID,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        path: PAUSE_PATH,
        mode: "exact",
        sourceVersionId: SOURCE_VERSION_ID,
        sourceBounds: bounds(10, 20, 64, 64),
        matteHash: "matte-hash",
        width: 64,
        height: 64,
        alphaStatus: "transparent",
        sha256: sha256(PNG_BYTES),
        provider: null,
        model: null,
      },
    ],
    coverage: [{ requirementId: ELEMENT_ID, elementIds: [ELEMENT_ID], status: "present", note: "seen in the render" }],
    ...overrides,
  };
}

type OutputRow = {
  outputId: string;
  elementSetId: string;
  elementId: string;
  mode: string;
  alphaStatus: string;
  reviewStatus: string;
  renderId: string;
};

type SelectionParams = {
  elementSetId: string;
  latestSetId: string;
  outputs: OutputRow[];
  selectedOutputIds: string[];
  renderId: string;
  groupElementIds: string[];
};

const outputRow = (overrides: Partial<OutputRow> = {}): OutputRow => ({
  outputId: OUTPUT_ID,
  elementSetId: SET_ID,
  elementId: ELEMENT_ID,
  mode: "exact",
  alphaStatus: "transparent",
  reviewStatus: "accepted",
  renderId: RENDER_ID,
  ...overrides,
});

const selection = (overrides: Partial<SelectionParams> = {}): SelectionParams => ({
  elementSetId: SET_ID,
  latestSetId: SET_ID,
  outputs: [outputRow()],
  selectedOutputIds: [OUTPUT_ID],
  renderId: RENDER_ID,
  groupElementIds: [],
  ...overrides,
});

const expectNotReady = (run: () => void) => {
  try {
    run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(GameUiError);
    const error = caught as GameUiError;
    expect(error.code).toBe("ASSET_PACK_NOT_READY");
    expect(error.status).toBe(409);
    return;
  }
  throw new Error("expected the selection to be rejected");
};

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

describe("stale map revisions", () => {
  it("refuses to preselect an output from an earlier map revision", async () => {
    const currentSetId = "11111111-1111-4111-8111-111111111111";
    const staleSetId = "22222222-2222-4222-8222-222222222222";
    const base = {
      elementId: ELEMENT_ID,
      elementName: "Continue button",
      kind: "button",
      mode: "exact" as const,
      alphaStatus: "transparent" as const,
      reviewStatus: "accepted" as const,
      reviewed: true,
      parentId: null,
    };
    mount(
      createElement(AssetPackExport, {
        renderId: RENDER_ID,
        elementSetId: currentSetId,
        outputs: [
          { ...base, id: "33333333-3333-4333-8333-333333333333", elementSetId: staleSetId },
          { ...base, id: "44444444-4444-4444-8444-444444444444", elementSetId: currentSetId },
        ],
        onRefresh: () => {},
      }),
    );
    await flush();

    // Only the current revision is offered for export, and the stale row explains why.
    const boxes = checkboxes();
    expect(boxes.map((node) => node.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(bodyText()).toContain("From an earlier map revision");
  });
});

describe("packEntryPath", () => {
  it("keeps hostile names inside the flat assets directory", () => {
    const hostile = ["../../etc/passwd", "", "A".repeat(80), "///", "..\\..\\windows\\system32", "   "];

    for (const name of hostile) {
      const path = packEntryPath(name, ELEMENT_ID);
      expect(path.startsWith("assets/")).toBe(true);
      expect(path.endsWith(`-${ELEMENT_ID}.png`)).toBe(true);
      expect(path).not.toContain("..");
      expect(path).not.toContain("\\");
      // Exactly one slash: assets/<file>, never a nested or escaped directory.
      expect(path.split("/")).toHaveLength(2);
      expect(path.slice("assets/".length, -`-${ELEMENT_ID}.png`.length)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("normalizes names and falls back when nothing usable remains", () => {
    expect(packEntryPath("../../etc/passwd", ELEMENT_ID)).toBe(`assets/etc-passwd-${ELEMENT_ID}.png`);
    expect(packEntryPath("", ELEMENT_ID)).toBe(`assets/element-${ELEMENT_ID}.png`);
    expect(packEntryPath("///", ELEMENT_ID)).toBe(`assets/element-${ELEMENT_ID}.png`);
    expect(packEntryPath("Health Bar / Track", ELEMENT_ID)).toBe(`assets/health-bar-track-${ELEMENT_ID}.png`);
  });

  it("caps the name at 40 characters without leaving a trailing hyphen", () => {
    expect(packEntryPath("A".repeat(80), ELEMENT_ID)).toBe(`assets/${"a".repeat(40)}-${ELEMENT_ID}.png`);
    expect(packEntryPath(`${"b".repeat(39)} `, ELEMENT_ID)).toBe(`assets/${"b".repeat(39)}-${ELEMENT_ID}.png`);
  });

  it("refuses a non-UUID element id instead of emitting an unsafe path", () => {
    expect(() => packEntryPath("Pause", "../../evil")).toThrow(GameUiError);
  });
});

describe("buildPackManifest", () => {
  it("pins the version, style revision, set revision and spec snapshot", () => {
    const manifest = buildPackManifest(manifestInput()) as Record<string, unknown>;

    expect(manifest.manifest_version).toBe(MANIFEST_VERSION);
    expect(manifest.style).toEqual({ id: STYLE_ID, revision: "style-revision-1" });
    expect(manifest.element_set).toEqual({ id: SET_ID, revision: 3 });
    expect(manifest.screen).toMatchObject({
      id: SCREEN_ID,
      render_id: RENDER_ID,
      source_version_id: SOURCE_VERSION_ID,
      width: 1280,
      height: 720,
      spec_snapshot: { schema_version: 1, name: "Battle HUD", requirements: [] },
    });
  });

  it("maps camelCase input onto snake_case manifest keys", () => {
    const manifest = buildPackManifest(manifestInput()) as Record<string, unknown>;

    expect((manifest.elements as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: ELEMENT_ID,
      parent_id: null,
      custom_type: null,
      visible_text: "II",
      visible_state: "default",
      bounds: { x: 10, y: 20, width: 64, height: 64 },
      z_index: 2,
      occluded: false,
    });
    expect((manifest.assets as Array<Record<string, unknown>>)[0]).toMatchObject({
      element_id: ELEMENT_ID,
      output_id: OUTPUT_ID,
      source_version_id: SOURCE_VERSION_ID,
      source_bounds: { x: 10, y: 20, width: 64, height: 64 },
      matte_hash: "matte-hash",
      alpha_status: "transparent",
      sha256: sha256(PNG_BYTES),
      provider: null,
      model: null,
    });
    expect((manifest.coverage as Array<Record<string, unknown>>)[0]).toEqual({
      requirement_id: ELEMENT_ID,
      element_ids: [ELEMENT_ID],
      status: "present",
      note: "seen in the render",
    });
  });

  it("carries no storage path, URL or workspace identifier anywhere", () => {
    const manifest = buildPackManifest(manifestInput());
    const serialized = JSON.stringify(manifest);

    const forbidden = ["workspace", "url", "signed", "token", "secret", "credential", "storage_path", "bucket"];
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          keys.push(key);
          walk(nested);
        }
      }
    };
    walk(manifest);

    for (const key of keys) {
      for (const word of forbidden) expect(key).not.toContain(word);
    }
    for (const word of forbidden) expect(serialized).not.toContain(word);
    expect(serialized).not.toContain("http");
    // The only path-like value is the archive entry itself.
    for (const asset of manifest.assets as Array<Record<string, unknown>>) {
      expect(String(asset.path).startsWith("assets/")).toBe(true);
    }
  });
});

describe("assertPackSelection", () => {
  it("accepts a selection of accepted, transparent, same-set outputs", () => {
    expect(() =>
      assertPackSelection(
        selection({
          outputs: [outputRow(), outputRow({ outputId: SECOND_OUTPUT_ID, elementId: CHILD_ID })],
          selectedOutputIds: [OUTPUT_ID, SECOND_OUTPUT_ID],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a stale element set", () => {
    expectNotReady(() => assertPackSelection(selection({ latestSetId: CHILD_ID })));
  });

  it("rejects an empty selection", () => {
    expectNotReady(() => assertPackSelection(selection({ selectedOutputIds: [] })));
  });

  it("rejects a pending or discarded output", () => {
    expectNotReady(() => assertPackSelection(selection({ outputs: [outputRow({ reviewStatus: "pending" })] })));
    expectNotReady(() => assertPackSelection(selection({ outputs: [outputRow({ reviewStatus: "discarded" })] })));
  });

  it("rejects an opaque output", () => {
    expectNotReady(() => assertPackSelection(selection({ outputs: [outputRow({ alphaStatus: "opaque" })] })));
  });

  it("rejects an output from a foreign render or another set revision", () => {
    expectNotReady(() => assertPackSelection(selection({ outputs: [outputRow({ renderId: CHILD_ID })] })));
    expectNotReady(() => assertPackSelection(selection({ outputs: [outputRow({ elementSetId: CHILD_ID })] })));
  });

  it("rejects a group element and an unknown output id", () => {
    expectNotReady(() => assertPackSelection(selection({ groupElementIds: [ELEMENT_ID] })));
    expectNotReady(() => assertPackSelection(selection({ selectedOutputIds: [CHILD_ID] })));
  });

  it("rejects two selected outputs for the same element", () => {
    expectNotReady(() =>
      assertPackSelection(
        selection({
          outputs: [outputRow(), outputRow({ outputId: SECOND_OUTPUT_ID })],
          selectedOutputIds: [OUTPUT_ID, SECOND_OUTPUT_ID],
        }),
      ),
    );
  });
});

describe("buildAssetZip", () => {
  it("produces exactly manifest.json plus one byte-identical PNG per file", async () => {
    const manifest = buildPackManifest(manifestInput());
    const files = [
      { path: PAUSE_PATH, bytes: PNG_BYTES },
      { path: packEntryPath("Coin counter", CHILD_ID), bytes: OTHER_PNG_BYTES },
    ];

    const entries = unzipSync(await buildAssetZip(files, manifest));

    expect(Object.keys(entries).sort()).toEqual(["manifest.json", ...files.map((file) => file.path)].sort());
    expect(JSON.parse(new TextDecoder().decode(entries["manifest.json"]))).toEqual(manifest);
    for (const file of files) expect(Array.from(entries[file.path])).toEqual(Array.from(file.bytes));
  });

  it("stores PNG entries uncompressed and writes the manifest first", async () => {
    const files = [{ path: PAUSE_PATH, bytes: PNG_BYTES }];
    const archive = await buildAssetZip(files, buildPackManifest(manifestInput()));

    // Level 0 leaves the payload verbatim in the archive; the manifest comes
    // first so a reader can find it without scanning the whole file.
    expect(indexOfBytes(archive, PNG_BYTES)).toBeGreaterThanOrEqual(0);
    expect(indexOfBytes(archive, new TextEncoder().encode("manifest.json"))).toBeLessThan(
      indexOfBytes(archive, new TextEncoder().encode(PAUSE_PATH)),
    );
  });

  it("rejects unsafe and duplicate entry paths", async () => {
    const manifest = buildPackManifest(manifestInput());

    await expect(buildAssetZip([{ path: "../evil.png", bytes: PNG_BYTES }], manifest)).rejects.toThrow(GameUiError);
    await expect(buildAssetZip([{ path: "nested/assets/a.png", bytes: PNG_BYTES }], manifest)).rejects.toThrow(
      /Unsafe pack entry path/,
    );
    await expect(buildAssetZip([{ path: "manifest.json", bytes: PNG_BYTES }], manifest)).rejects.toThrow(
      /Unsafe pack entry path/,
    );
    await expect(buildAssetZip([{ path: "assets/..png", bytes: PNG_BYTES }], manifest)).rejects.toThrow(
      /Unsafe pack entry path/,
    );
    await expect(
      buildAssetZip(
        [
          { path: PAUSE_PATH, bytes: PNG_BYTES },
          { path: PAUSE_PATH, bytes: OTHER_PNG_BYTES },
        ],
        manifest,
      ),
    ).rejects.toThrow(/Duplicate pack entry path/);
  });
});

type PackRow = {
  id: string;
  elementId: string;
  elementName: string;
  kind: string;
  mode: "exact" | "reconstructed";
  alphaStatus: "transparent" | "opaque";
  reviewStatus: "pending" | "accepted" | "discarded";
  reviewed: boolean;
  parentId?: string | null;
};

const packRow = (overrides: Partial<PackRow> = {}): PackRow => ({
  id: OUTPUT_ID,
  elementId: ELEMENT_ID,
  elementName: "Pause button",
  kind: "button",
  mode: "exact",
  alphaStatus: "transparent",
  reviewStatus: "accepted",
  reviewed: true,
  parentId: null,
  ...overrides,
});

type Call = { url: string; init?: RequestInit };

let calls: Call[] = [];
let blobs: Blob[] = [];
let downloads: string[] = [];
let restoreUrl = () => {};

function exportBody(overrides: { path?: string; byteSize?: number; sha256?: string; url?: string } = {}) {
  return {
    manifest: buildPackManifest(manifestInput()),
    files: [
      {
        outputId: OUTPUT_ID,
        path: overrides.path ?? PAUSE_PATH,
        url: overrides.url ?? "https://files.test/pause",
        byteSize: overrides.byteSize ?? PNG_BYTES.byteLength,
        sha256: overrides.sha256 ?? sha256(PNG_BYTES),
      },
    ],
    expiresAt: "2026-09-16T10:10:00.000Z",
  };
}

/** Export endpoint plus the signed file URL it hands back. */
function installFetch(options: { ok?: boolean; error?: { code: string; message: string }; hash?: string } = {}) {
  const ok = options.ok ?? true;
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `/api/game-ui/renders/${RENDER_ID}/export`) {
      if (!ok) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: options.error ?? { code: "ASSET_PACK_NOT_READY", message: "Not ready" } }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return { ok: true, status: 200, json: async () => exportBody({ sha256: options.hash }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url === "https://files.test/pause") {
      const bytes = PNG_BYTES.slice();
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer };
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

/** Drains the promise chains of a download without waiting on wall-clock time. */
const flush = async () => {
  await act(async () => {
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
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

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((node) =>
    (node.getAttribute("aria-label") ?? node.textContent ?? "").includes(label),
  );
  expect(button, `${label} button`).toBeTruthy();
  return button!;
}

const click = async (label: string) => {
  act(() => {
    findButton(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

const bodyText = () => document.body.textContent ?? "";
const checkboxes = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[role='checkbox']"));

beforeEach(() => {
  blobs = [];
  downloads = [];
  installFetch();
  // jsdom ships no object URLs, so the archive is captured as it is handed off.
  const originalCreate = Reflect.get(URL, "createObjectURL");
  const originalRevoke = Reflect.get(URL, "revokeObjectURL");
  Reflect.set(URL, "createObjectURL", (blob: Blob) => {
    blobs.push(blob);
    return `blob:test-${blobs.length}`;
  });
  Reflect.set(URL, "revokeObjectURL", () => {});
  restoreUrl = () => {
    Reflect.set(URL, "createObjectURL", originalCreate);
    Reflect.set(URL, "revokeObjectURL", originalRevoke);
  };
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function capture(this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  restoreUrl();
  vi.restoreAllMocks();
});

const mountExport = (outputs: PackRow[], onRefresh = vi.fn()) => {
  mount(createElement(AssetPackExport, { renderId: RENDER_ID, elementSetId: SET_ID, outputs, onRefresh }));
  return onRefresh;
};

describe("AssetPackExport", () => {
  it("posts the selected outputs and downloads a verified archive", async () => {
    const onRefresh = mountExport([packRow()]);
    await flush();

    expect(bodyText()).toContain("1 of 1 exportable elements selected.");
    await click("Download ZIP");

    const request = calls.find((call) => call.url === `/api/game-ui/renders/${RENDER_ID}/export`);
    expect(request, "export request").toBeTruthy();
    expect(JSON.parse(String(request!.init?.body))).toEqual({ elementSetId: SET_ID, outputIds: [OUTPUT_ID] });

    expect(blobs).toHaveLength(1);
    expect(downloads).toEqual([`game-ui-${RENDER_ID}.zip`]);
    const entries = unzipSync(new Uint8Array(await blobs[0].arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["manifest.json", PAUSE_PATH].sort());
    expect(Array.from(entries[PAUSE_PATH])).toEqual(Array.from(PNG_BYTES));
    expect(bodyText()).toContain("Pack downloaded with the pinned manifest.");
    expect(onRefresh).toHaveBeenCalled();
  });

  it("estimates the pack size from the export response", async () => {
    mountExport([packRow()]);
    await flush();
    await click("Download ZIP");

    expect(bodyText()).toContain(`Estimated ${PNG_BYTES.byteLength} B across 1 file.`);
  });

  it("disables rows that cannot join a transparent pack and says why", async () => {
    mountExport([
      packRow(),
      packRow({ id: CHILD_ID, elementId: CHILD_ID, elementName: "Pause glow", kind: "group" }),
      packRow({ id: ASSET_ID, elementId: ASSET_ID, elementName: "Opaque badge", alphaStatus: "opaque" }),
      packRow({ id: VERSION_ID, elementId: VERSION_ID, elementName: "Pending icon", reviewStatus: "pending" }),
      packRow({ id: SOURCE_VERSION_ID, elementId: SOURCE_VERSION_ID, elementName: "Unreviewed text", reviewed: false }),
    ]);
    await flush();

    expect(bodyText()).toContain("1 of 1 exportable elements selected.");
    expect(bodyText()).toContain("Group elements only organize the screen");
    expect(bodyText()).toContain("Opaque output");
    expect(bodyText()).toContain("Pending your review");
    expect(bodyText()).toContain("Not reviewed yet");
    expect(checkboxes()).toHaveLength(5);
    expect(checkboxes().filter((node) => node.disabled)).toHaveLength(4);
  });

  it("warns when a child is selected alongside its parent", async () => {
    mountExport([
      packRow({ kind: "health_bar", elementName: "Health bar" }),
      packRow({ id: CHILD_ID, elementId: CHILD_ID, elementName: "Health fill", kind: "bar_fill", parentId: ELEMENT_ID }),
    ]);
    await flush();

    expect(bodyText()).toContain("Health fill sits inside Health bar: both PNGs cover the same pixels");
  });

  it("lets the user drop an element from the selection", async () => {
    mountExport([packRow(), packRow({ id: CHILD_ID, elementId: CHILD_ID, elementName: "Coin counter" })]);
    await flush();
    expect(bodyText()).toContain("2 of 2 exportable elements selected.");

    act(() => {
      checkboxes()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(bodyText()).toContain("1 of 2 exportable elements selected.");
    await click("Download ZIP");
    expect(JSON.parse(String(calls.find((call) => call.url.includes("/export"))!.init?.body))).toEqual({
      elementSetId: SET_ID,
      outputIds: [CHILD_ID],
    });
  });

  it("shows the server's refusal and downloads nothing", async () => {
    installFetch({ ok: false, error: { code: "ASSET_PACK_NOT_READY", message: "This element set is stale" } });
    mountExport([packRow()]);
    await flush();
    await click("Download ZIP");

    expect(bodyText()).toContain("ASSET_PACK_NOT_READY: This element set is stale");
    expect(bodyText()).not.toContain("Pack downloaded");
    expect(blobs).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("refuses to build the archive when a file's hash does not match", async () => {
    installFetch({ hash: sha256(OTHER_PNG_BYTES) });
    mountExport([packRow()]);
    await flush();
    await click("Download ZIP");

    expect(bodyText()).toContain("did not match the pinned size and hash");
    expect(bodyText()).not.toContain("Pack downloaded");
    expect(blobs).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("refuses to build a pack that is missing a selected file", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return { ok: true, status: 200, json: async () => ({ manifest: {}, files: [], expiresAt: null }), arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;

    mountExport([packRow()]);
    await flush();
    await click("Download ZIP");

    expect(bodyText()).toContain("ASSET_PACK_NOT_READY: expected 1 files, received 0");
    expect(blobs).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("cancels an in-flight download without reporting success or a failure", async () => {
    let sawSignal: AbortSignal | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/export")) {
        return { ok: true, status: 200, json: async () => exportBody({ url: "https://files.test/slow" }), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      sawSignal = init?.signal ?? undefined;
      return new Promise<never>((_resolve, reject) => {
        // The signed URL never answers: only the user's cancel ends the wait.
        sawSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;

    mountExport([packRow()]);
    await flush();
    await click("Download ZIP");
    expect(bodyText()).toContain("Verifying 1 of 1");
    expect(sawSignal?.aborted).toBe(false);

    await click("Cancel pack download");

    expect(sawSignal?.aborted).toBe(true);
    expect(blobs).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(bodyText()).not.toContain("Pack downloaded");
    expect(bodyText()).not.toContain("FILE_UNAVAILABLE");
  });

  it("shows an empty state when nothing has been exported yet", async () => {
    mountExport([]);
    await flush();

    expect(bodyText()).toContain("No exported elements yet");
    expect(findButton("Download ZIP").disabled).toBe(true);
  });
});
