vi.mock("@/supabase/client", () => ({
  createClient: vi.fn(() => ({
    channel: vi.fn(() => ({
      on: vi.fn(() => ({
        subscribe: vi.fn(),
      })),
    })),
    removeChannel: vi.fn(),
  })),
}));

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import { RecentPrompts } from "@/components/studio/ModuleContextSidebar";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";

const job = (overrides: Partial<ProjectJobFeedItem["job"]> = {}): ProjectJobFeedItem["job"] => ({
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: "33333333-3333-4333-8333-333333333333", module: "projects",
  requested_by: "44444444-4444-4444-8444-444444444444",
  asset_id: null, parent_version_id: null, version_id: null,
  operation: "text_to_image", provider: "google", model: "google/gemini-2.5-flash-image", status: "queued",
  attempt_count: 0, lease_owner: null, lease_expires_at: null, provider_request_id: null, provider_status: null,
  input: { prompt: "portrait study", count: 1, size: "1024x1024", quality: "auto" }, output: {},
  error_code: null, error_message: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", completed_at: null,
  ...overrides,
});

describe("module sidebar", () => {
  it("renders both module links with the playground module active by default", () => {
    const html = renderToStaticMarkup(<ProjectSidebar userEmail="user@example.com" />);
    expect(html).toContain("Modules");
    expect(html).toContain("Image Playground");
    expect(html).toContain('href="/projects"');
    expect(html).toContain("Style");
    expect(html).toContain('href="/style"');
    expect(html).toContain('aria-current="page"');
    const playgroundPos = html.indexOf('href="/projects"');
    const stylePos = html.indexOf('href="/style"');
    const currentPos = html.indexOf('aria-current="page"');
    expect(currentPos).toBeGreaterThan(playgroundPos);
    expect(currentPos).toBeLessThan(stylePos);
  });
  it("moves the active highlight to Style in the style workspace", () => {
    const html = renderToStaticMarkup(<ProjectSidebar activeModule="style" userEmail="user@example.com" />);
    expect(html).toContain('href="/style"');
    expect(html).toContain('aria-current="page"');
    const styleIndex = html.indexOf('href="/style"');
    const playgroundIndex = html.indexOf('href="/projects"');
    const currentIndex = html.indexOf('aria-current="page"');
    expect(playgroundIndex).toBeLessThan(styleIndex);
    expect(currentIndex).toBeLessThan(styleIndex);
  });

  it("routes recent prompts by job scope: project jobs to the project, style jobs to /style", () => {
    const html = renderToStaticMarkup(
      <RecentPrompts
        items={[
          { job: job(), result_urls: [] },
          { job: job({ id: "aaaaaaa1-1111-4111-8111-111111111111", project_id: null, module: "style", input: { prompt: "restyle", count: 1, size: "1024x1024", quality: "auto", style_id: "55555555-5555-4555-8555-555555555555" } }), result_urls: [] },
        ]}
      />,
    );
    expect(html).toContain('href="/projects/33333333-3333-4333-8333-333333333333"');
    expect(html).toContain('href="/style"');
    expect(html).toContain("portrait study");
    expect(html).toContain("restyle");
  });
});
