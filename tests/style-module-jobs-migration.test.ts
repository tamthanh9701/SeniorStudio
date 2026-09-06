import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0023_style_module_jobs.sql"), "utf8");

describe("Style module job migration contracts", () => {
  it("makes project_id nullable", () => {
    expect(sql).toContain("alter table public.ai_jobs");
    expect(sql).toContain("alter column project_id drop not null");
  });

  it("adds module column with allowed values and default", () => {
    expect(sql).toContain("add column module text not null default 'projects'");
    expect(sql).toContain("constraint ai_jobs_module_check check (module in ('projects', 'style'))");
  });

  it("creates module/style index", () => {
    expect(sql).toContain("create index ai_jobs_module_style_idx on public.ai_jobs(module, (input->>'style_id'))");
  });

  it("enforces module shape constraints", () => {
    expect(sql).toContain("add constraint ai_jobs_module_shape_check check (");
    expect(sql).toContain("(module = 'projects' and project_id is not null)");
    expect(sql).toContain("(module = 'style' and project_id is null and input->>'style_id' is not null)");
  });

  it("updates enqueue_ai_job to accept p_module with default projects", () => {
    expect(sql).toContain("create or replace function public.enqueue_ai_job(");
    expect(sql).toContain("p_module text default 'projects'");
    expect(sql).toContain("if p_module not in ('projects', 'style') then");
  });

  it("validates style module requires null project and active style", () => {
    expect(sql).toContain("if p_module = 'style' then");
    expect(sql).toContain("if p_project_id is not null then");
    expect(sql).toContain("STYLE_NOT_ACTIVE");
  });

  it("declares all plpgsql variables used in the function body", () => {
    expect(sql).toContain("v_parent_project uuid");
  });
});
