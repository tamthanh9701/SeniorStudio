import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0024_style_libraries.sql"), "utf8");

describe("style_libraries migration contracts", () => {
  it("creates style_libraries table", () => {
    expect(sql).toContain("create table public.style_libraries");
    expect(sql).toContain("id uuid primary key");
    expect(sql).toContain("workspace_id uuid not null references public.workspaces(id) on delete cascade");
    expect(sql).toContain("name text not null check (char_length(btrim(name)) between 1 and 100)");
    expect(sql).toContain("sort_order integer not null default 0");
  });

  it("creates index on workspace_id", () => {
    expect(sql).toContain("create index style_libraries_workspace_idx on public.style_libraries(workspace_id)");
  });

  it("adds library_id column to styles table", () => {
    expect(sql).toContain("alter table public.styles");
    expect(sql).toContain("add column library_id uuid references public.style_libraries(id) on delete set null");
  });

  it("enables RLS on style_libraries", () => {
    expect(sql).toContain("alter table public.style_libraries enable row level security");
  });

  it("creates RLS policy with workspace scope", () => {
    expect(sql).toContain("create policy \"Users can manage style libraries in their workspace\" on public.style_libraries");
    expect(sql).toContain("using (workspace_id in (select public.current_workspace_ids()))");
    expect(sql).toContain("with check (workspace_id in (select public.current_workspace_ids()))");
  });

  it("creates updated_at trigger", () => {
    expect(sql).toContain("create trigger style_libraries_set_updated_at before update on public.style_libraries");
    expect(sql).toContain("for each row execute function public.set_updated_at()");
  });
});
