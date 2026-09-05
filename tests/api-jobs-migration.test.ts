import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0012_api_jobs.sql"), "utf8");

describe("API job migration contracts", () => {
  it("preserves atomic asset commits while removing browser tables", () => {
    expect(sql).not.toContain("drop function if exists public.commit_asset_version");
    expect(sql).toContain("drop table if exists public.chat_messages");
    expect(sql).toContain("drop table if exists public.browser_jobs");
  });

  it("claims jobs exclusively and enforces leases", () => {
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("LEASE_NOT_OWNED");
    expect(sql).toContain("status in ('submitting', 'processing') and lease_expires_at < now()");
  });

  it("commits result references only after the version exists", () => {
    expect(sql).toContain("select 1 from public.asset_versions where id = p_version_id and asset_id = p_asset_id");
    expect(sql).toContain("alter publication supabase_realtime add table public.ai_jobs");
  });
});
