// @vitest-environment jsdom
// The Game UI module UI is judged on observable behaviour: what request a click
// produces, what stays unsaved, and what the user is told when the server refuses.
// Markup is never asserted; the browser has to be able to reach each control, so
// every interaction below goes through the same DOM a user would.

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

vi.mock("next/image", () => ({
  default: ({ src, alt, ...rest }: { src: string; alt?: string }) => createElement("img", { src: String(src), alt: alt ?? "", ...rest }),
}));

vi.mock("@/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  }),
}));

import sharp from "sharp";
import ElementAssetDialog from "@/components/game-ui/ElementAssetDialog";
import { RenderWorkspace } from "@/components/game-ui/ElementEditor";
import ForegroundMaskEditor from "@/components/game-ui/ForegroundMaskEditor";
import ScreenWorkspace from "@/components/game-ui/ScreenWorkspace";
import type { ElementDocument } from "@/lib/game-ui/contracts";
import type { GameUiOutputView, GameUiReferenceView, GameUiRenderSummary, GameUiScreenSummary } from "@/lib/game-ui/service";
import type { AiJob } from "@/db/ai-jobs";
import type { ModelCatalogEntry } from "@/lib/ai/models";

// jsdom lacks ResizeObserver and Radix's Slider measures itself with it; the matte
// editor paints without layout, so a no-op observer is enough to mount it.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

const STYLE_ID = "11111111-1111-4111-8111-111111111111";
const SCREEN_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const RENDER_ID = "33333333-3333-4333-8333-333333333333";
const SET_ID = "44444444-4444-4444-8444-444444444444";
const REFERENCE_ID = "55555555-5555-4555-8555-555555555555";
const REQUIREMENT_ID = "66666666-6666-4666-8666-666666666666";
const ELEMENT_ID = "77777777-7777-4777-8777-777777777777";
const OUTPUT_ID = "88888888-8888-4888-8888-888888888888";
const VERSION_ID = "99999999-9999-4999-8999-999999999999";
const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAN_HASH = "hash-returned-by-the-plan-route";
const SOURCE_URL = "https://test.supabase.co/signed/screen.png";

type Call = { url: string; init?: RequestInit };

const respond = (body: unknown, ok = true, status = ok ? 200 : 409) => ({ ok, status, json: async () => body });

function installFetch(handler: (url: string, init: RequestInit | undefined) => unknown) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

function makeJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: JOB_ID,
    workspace_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    project_id: null,
    module: "style",
    requested_by: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    asset_id: ASSET_ID,
    parent_version_id: null,
    version_id: VERSION_ID,
    operation: "text_to_image",
    provider: "openai",
    model: "openai/gpt-image-2",
    status: "queued",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    provider_request_id: null,
    provider_status: null,
    input: { prompt: "Battle HUD with a coin counter", count: 1, size: "1024x1024", quality: "auto" },
    output: {},
    error_code: null,
    error_message: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    style_id: STYLE_ID,
    ...overrides,
  };
}

function requirement() {
  return {
    id: REQUIREMENT_ID,
    kind: "counter" as const,
    custom_type: null,
    name: "Coin counter",
    purpose: "shows the collected coins",
    visible_text: "0",
    visible_state: null,
    required: true,
  };
}

function makeScreen(overrides: Partial<GameUiScreenSummary> = {}): GameUiScreenSummary {
  return {
    id: SCREEN_ID,
    name: "Battle HUD",
    spec: {
      schema_version: 1,
      name: "Battle HUD",
      description: "Avatar, health bar and coin counter over a battle scene",
      layout_notes: "Avatar top left, counter top right",
      requirements: [requirement()],
    },
    draftRevision: 3,
    wireframeVersionId: null,
    wireframeUrl: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    renderCount: 0,
    ...overrides,
  };
}

function liveReference(): GameUiReferenceView {
  return {
    id: REFERENCE_ID,
    mime_type: "image/png",
    byte_size: 2048,
    width: 1024,
    height: 1024,
    created_at: "2026-09-01T00:00:00.000Z",
    signed_url: "https://test.supabase.co/signed/reference.png",
  };
}

function makeRender(): GameUiRenderSummary {
  return {
    id: RENDER_ID,
    screenId: SCREEN_ID,
    assetId: ASSET_ID,
    versionId: VERSION_ID,
    width: 1024,
    height: 1024,
    createdAt: "2026-09-02T00:00:00.000Z",
    sourceUrl: SOURCE_URL,
    jobId: JOB_ID,
    jobStatus: "succeeded",
    errorCode: null,
    errorMessage: null,
    elementSetId: SET_ID,
    elementSetRevision: 2,
    outputCount: 0,
  };
}

function makeDocument(): ElementDocument {
  return {
    schema_version: 1,
    render_id: RENDER_ID,
    source_version_id: VERSION_ID,
    canvas: { width: 1024, height: 1024 },
    elements: [
      {
        id: ELEMENT_ID,
        parent_id: null,
        kind: "button",
        custom_type: null,
        name: "Pause button",
        purpose: "pauses the battle",
        visible_text: "II",
        visible_state: null,
        bounds: { x: 900, y: 40, width: 64, height: 64 },
        z_index: 1,
        occluded: false,
        confidence: 0.9,
        notes: "",
        reviewed: true,
      },
    ],
    coverage: [{ requirement_id: REQUIREMENT_ID, element_ids: [ELEMENT_ID], status: "present", note: "" }],
  };
}

function makeOutput(overrides: Partial<GameUiOutputView> = {}): GameUiOutputView {
  return {
    id: OUTPUT_ID,
    elementId: ELEMENT_ID,
    mode: "exact",
    alphaStatus: "transparent",
    reviewStatus: "pending",
    assetId: ASSET_ID,
    versionId: VERSION_ID,
    elementSetId: SET_ID,
    width: 64,
    height: 64,
    contentHash: "a".repeat(64),
    provider: null,
    model: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    url: "https://test.supabase.co/signed/output.png",
    ...overrides,
  };
}

const MODELS = [
  {
    id: "openai/gpt-image-2",
    label: "OpenAI GPT Image 2",
    provider: "openai",
    operations: ["text_to_image", "image_to_image"],
    sizes: ["1024x1024", "1536x1024"],
    qualities: ["auto"],
    maxCount: 4,
    supportsTransparentBackground: true,
  },
] as unknown as ModelCatalogEntry[];

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
  act(() => {
    root.render(element);
  });
  return { host, root };
};

const unmount = (host: HTMLElement, root: { unmount: () => void }) => {
  act(() => {
    root.unmount();
  });
  host.remove();
};

const bodyText = () => document.body.textContent ?? "";

/** Dialogs render into a portal outside the mounted host, so the scope is explicit. */
const findButton = (scope: ParentNode, label: string) => {
  const button = Array.from(scope.querySelectorAll("button")).find((node) => (node.textContent ?? "").includes(label));
  expect(button, `${label} button`).toBeTruthy();
  return button!;
};

const clickButton = async (scope: ParentNode, label: string) => {
  act(() => {
    findButton(scope, label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const inputValue = (scope: ParentNode, selector: string) => (scope.querySelector(selector) as HTMLInputElement).value;

const pointer = (target: Element, type: string, x: number, y: number) => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
};

beforeEach(() => {
  document.body.innerHTML = "";
  nav.push.mockClear();
  nav.refresh.mockClear();
  vi.restoreAllMocks();
});

describe("screen workspace generation", () => {
  it("sends the plan's own hash as the generation consent", async () => {
    const calls = installFetch((url) => {
      if (url.endsWith("/plan")) {
        return respond({
          plan: {
            intent: "screen",
            operation: "text_to_image",
            requestedModelId: "openai/gpt-image-2",
            effectiveModelId: "openai/gpt-image-2",
            provider: "openai",
            size: "1024x1024",
            quality: "auto",
            count: 1,
            referenceIds: [REFERENCE_ID],
            omittedReferenceIds: [],
            sourceVersionId: null,
            modelChanged: false,
            explanation: "One image from the confirmed style.",
            compiledPrompt: "STYLE:\n…\nSCREEN_REQUIREMENTS:\n- Coin counter",
            planHash: PLAN_HASH,
          },
        });
      }
      if (url.endsWith("/generate")) return respond({ job: makeJob() }, true, 202);
      // The live job feed polls while a job is queued; an empty snapshot keeps the
      // status the test set up.
      if (url.includes("/ai-jobs")) return respond({ jobs: [] });
      return respond({ error: { code: "UNEXPECTED", message: url } }, false, 500);
    });

    const { host, root } = mount(
      createElement(ScreenWorkspace, {
        styleId: STYLE_ID,
        screen: makeScreen(),
        initialRenders: [],
        initialRendersCursor: null,
        wireframeDimensions: null,
        references: [liveReference()],
        models: MODELS,
        initialJobs: [],
      }),
    );
    await flush();

    await clickButton(host, "Generate image");
    expect(calls.map((call) => call.url)).toContain(`/api/game-ui/screens/${SCREEN_ID}/plan`);
    // The plan the user saw is what they will consent to.
    expect(bodyText()).toContain("openai/gpt-image-2");
    expect(bodyText()).toContain("1 included, 0 omitted");

    await clickButton(document, "Confirm generation");

    const generate = calls.find((call) => call.url.endsWith("/generate"));
    expect(generate, "generate request").toBeTruthy();
    const body = JSON.parse(String(generate!.init?.body));
    // The consent hash must be exactly what the plan route returned, not a client copy.
    expect(body.consent.planHash).toBe(PLAN_HASH);
    expect(body.expectedRevision).toBe(3);
    expect(body.referenceIds).toEqual([REFERENCE_ID]);

    unmount(host, root);
  });
});

describe("screen workspace draft", () => {
  it("keeps requirement edits local until Save is pressed", async () => {
    const calls = installFetch((url, init) => {
      if (init?.method === "PATCH") {
        return respond({ screen: { ...makeScreen(), draftRevision: 4 } });
      }
      return respond({ error: { code: "UNEXPECTED", message: url } }, false, 500);
    });

    const { host, root } = mount(
      createElement(ScreenWorkspace, {
        styleId: STYLE_ID,
        screen: makeScreen(),
        initialRenders: [],
        initialRendersCursor: null,
        wireframeDimensions: null,
        references: [liveReference()],
        models: MODELS,
        initialJobs: [],
      }),
    );
    await flush();

    act(() => {
      setInputValue(host.querySelector('input[aria-label="Requirement 1 name"]') as HTMLInputElement, "Continue button");
    });
    await flush();

    expect(host.textContent).toContain("Unsaved draft edits");
    expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);

    await clickButton(host, "Save draft");

    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch, "screen PATCH").toBeTruthy();
    const body = JSON.parse(String(patch!.init?.body));
    expect(body.expectedRevision).toBe(3);
    expect(body.spec.requirements[0].name).toBe("Continue button");
    expect(body.spec.requirements[0].id).toBe(REQUIREMENT_ID);

    unmount(host, root);
  });
});

describe("element map saving", () => {
  it("keeps the local document and offers a reload when the revision conflicts", async () => {
    const calls = installFetch((url, init) => {
      if (init?.method === "PUT") {
        return respond({ error: { code: "SCREEN_VERSION_CONFLICT", message: "This map has a newer revision; use the newest one" } }, false, 409);
      }
      return respond({ error: { code: "UNEXPECTED", message: url } }, false, 500);
    });

    const { host, root } = mount(
      createElement(RenderWorkspace, {
        styleId: STYLE_ID,
        screenId: SCREEN_ID,
        screenName: "Battle HUD",
        render: makeRender(),
        spec: makeScreen().spec,
        initialElementSet: { id: SET_ID, revision: 2, document: makeDocument() },
        initialOutputs: [],
        initialOutputsCursor: null,
        models: MODELS,
      }),
    );
    await flush();

    act(() => {
      setInputValue(host.querySelector('input[aria-label="Element name"]') as HTMLInputElement, "Battle pause button");
    });
    await flush();

    await clickButton(host, "Save elements");

    const put = calls.find((call) => call.init?.method === "PUT");
    expect(put, "elements PUT").toBeTruthy();
    expect(JSON.parse(String(put!.init?.body)).expectedRevision).toBe(2);

    // The conflict is named, the local edit survives and a reload is offered.
    expect(host.textContent).toContain("SCREEN_VERSION_CONFLICT");
    expect(host.textContent).toContain("Your edits are still here");
    expect(findButton(host, "Reload")).toBeTruthy();
    expect(inputValue(host, 'input[aria-label="Element name"]')).toBe("Battle pause button");

    unmount(host, root);
  });
});

/** The matte this editor hands to the extract route has to be a real RGBA PNG. */
async function decodeMatte(png: Uint8Array) {
  const metadata = await sharp(Buffer.from(png)).metadata();
  const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphas = new Set<number>();
  for (let index = 3; index < data.length; index += 4) alphas.add(data[index]);
  return { metadata, info, alphas };
}

describe("element geometry", () => {
  it("moves the selected child box instead of snapping it to its parent", async () => {
    const calls = installFetch((url, init) => {
      if (init?.method === "PUT") return respond({ elementSet: { id: SET_ID, revision: 3, document: makeDocument() } });
      return respond({ error: { code: "UNEXPECTED", message: url } }, false, 500);
    });

    // A popup with a button inside it, as a reviewed screen actually looks.
    const document: ElementDocument = {
      ...makeDocument(),
      elements: [
        {
          id: PARENT_ID,
          parent_id: null,
          kind: "popup",
          custom_type: null,
          name: "Victory popup",
          purpose: "",
          visible_text: "VICTORY",
          visible_state: null,
          bounds: { x: 262, y: 288, width: 500, height: 300 },
          z_index: 0,
          occluded: false,
          confidence: 0.9,
          notes: "",
          reviewed: true,
        },
        { ...makeDocument().elements[0], id: ELEMENT_ID, parent_id: PARENT_ID, name: "Continue button", bounds: { x: 362, y: 514, width: 300, height: 56 } },
      ],
    };

    const { host, root } = mount(
      createElement(RenderWorkspace, {
        styleId: STYLE_ID,
        screenId: SCREEN_ID,
        screenName: "Battle HUD",
        render: makeRender(),
        spec: makeScreen().spec,
        initialElementSet: { id: SET_ID, revision: 2, document },
        initialOutputs: [],
        initialOutputsCursor: null,
        models: MODELS,
      }),
    );
    await flush();

    // Select the nested button, then move it with the numeric boxes.
    act(() => {
      const row = [...host.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim().startsWith("Continue button"));
      row?.click();
    });
    await flush();
    act(() => {
      setInputValue(host.querySelector("#element-x") as HTMLInputElement, "372");
      setInputValue(host.querySelector("#element-y") as HTMLInputElement, "520");
      setInputValue(host.querySelector("#element-width") as HTMLInputElement, "280");
      setInputValue(host.querySelector("#element-height") as HTMLInputElement, "44");
    });
    await flush();

    await clickButton(host, "Save elements");
    const put = calls.find((call) => call.init?.method === "PUT");
    expect(put, "elements PUT").toBeTruthy();
    const saved = JSON.parse(String(put!.init?.body)).document as ElementDocument;
    const button = saved.elements.find((element) => element.id === ELEMENT_ID)!;
    const popup = saved.elements.find((element) => element.id === PARENT_ID)!;
    expect(button.bounds).toEqual({ x: 372, y: 520, width: 280, height: 44 });
    expect(popup.bounds).toEqual({ x: 262, y: 288, width: 500, height: 300 });
    expect(button.parent_id).toBe(PARENT_ID);

    unmount(host, root);
  });
});

describe("foreground matte", () => {
  it("starts by removing nothing and produces a different matte once painted and inverted", async () => {
    const payloads: Array<Uint8Array | null> = [];
    const { host, root } = mount(
      createElement(ForegroundMaskEditor, {
        imageUrl: SOURCE_URL,
        width: 64,
        height: 64,
        onMatteChange: (matte: Uint8Array | null) => payloads.push(matte),
      }),
    );
    await flush();

    expect(host.textContent).toContain("Nothing is removed");
    const untouched = payloads.at(-1);
    expect(untouched, "default matte").toBeTruthy();
    expect(Array.from(untouched!.slice(0, 4))).toEqual([137, 80, 78, 71]);

    // Default state: every pixel is kept, and the file is still an RGBA PNG of the
    // element's own box size, which is what the extraction pipeline requires.
    const keptAll = await decodeMatte(untouched!);
    expect(keptAll.metadata.hasAlpha).toBe(true);
    expect([keptAll.info.width, keptAll.info.height]).toEqual([64, 64]);
    expect([...keptAll.alphas]).toEqual([255]);

    const surface = host.querySelector('[aria-label="Foreground mask surface"]') as HTMLElement;
    expect(surface, "paint surface").toBeTruthy();
    act(() => {
      pointer(surface, "pointerdown", 20, 20);
      pointer(surface, "pointermove", 28, 26);
      pointer(surface, "pointerup", 28, 26);
    });
    await flush();

    const painted = payloads.at(-1);
    expect(host.textContent).toContain("Removed");
    expect(host.textContent).not.toContain("Nothing is removed");
    expect(painted).toBeTruthy();
    expect(Array.from(painted!)).not.toEqual(Array.from(untouched!));

    // Painting removes pixels and leaves the rest exactly as they were.
    const paintedAlphas = await decodeMatte(painted!);
    expect(paintedAlphas.alphas.has(0)).toBe(true);
    expect(paintedAlphas.alphas.has(255)).toBe(true);

    await clickButton(host, "Invert");

    const inverted = payloads.at(-1);
    expect(inverted).toBeTruthy();
    expect(Array.from(inverted!)).not.toEqual(Array.from(painted!));

    unmount(host, root);
  });
});

describe("element assets", () => {
  it("marks an opaque result as unusable and refuses to accept it", async () => {
    installFetch((url) => respond({ error: { code: "UNEXPECTED", message: url } }, false, 500));
    const { host, root } = mount(
      createElement(ElementAssetDialog, {
        renderId: RENDER_ID,
        elementSetId: SET_ID,
        element: makeDocument().elements[0],
        imageUrl: SOURCE_URL,
        imageWidth: 1024,
        imageHeight: 1024,
        outputs: [makeOutput({ alphaStatus: "opaque", mode: "reconstructed" })],
        models: MODELS,
        onClose: () => {},
        onRefresh: () => {},
      }),
    );
    await flush();

    expect(bodyText()).toContain("opaque");
    expect(bodyText()).toContain("background was not removed");
    expect(findButton(document, "Accept").hasAttribute("disabled")).toBe(true);

    unmount(host, root);
  });
});
