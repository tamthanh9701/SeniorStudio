import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0011_browser_bridge.sql"), "utf8");

describe("browser bridge migration contracts", () => {
  it("protects service-only mutation RPCs", () => {
    for (const rpc of ["commit_asset_version", "claim_browser_job", "renew_browser_job_lease", "set_browser_job_state", "complete_browser_chat_job", "complete_browser_image_job", "fail_browser_job"]) {
      expect(sql).toContain(`function public.${rpc}`);
    }
    expect(sql).toContain("to service_role");
    expect(sql).toContain("SERVICE_ROLE_REQUIRED");
  });

  it("enforces thread order and expired submission review", () => {
    expect(sql).toContain("browser_jobs_one_active_per_thread");
    expect(sql).toContain("THREAD_BUSY");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("WORKER_INTERRUPTED_AFTER_SUBMISSION");
    expect(sql).toContain("status in ('submitting','generating','downloading','persisting')");
  });

  it("commits explicit storage-aligned asset and version IDs", () => {
    expect(sql).toContain("p_asset_id uuid");
    expect(sql).toContain("p_version_id uuid");
    expect(sql).toContain("p_storage_path text");
    expect(sql).toContain("p_parent_version_id");
  });
});
