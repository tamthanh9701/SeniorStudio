#!/usr/bin/env tsx
/** Apply the immutable migration chain only after exact target verification. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const mode = process.argv[2];
if (mode !== "CLEAN" && mode !== "UPGRADE") throw new Error("usage: apply-staging-migrations.ts CLEAN|UPGRADE");
for (const key of ["STAGING_SUPABASE_PROJECT_REF", "TEST_DATABASE_URL", "STAGING_DB_CA", "STAGING_DB_HOST", "STAGING_DB_USER", "STAGING_DB_PORT"]) {
  if (!process.env[key]?.trim()) throw new Error(`missing protected environment variable ${key}`);
}
if (process.env.ALLOW_STAGING_MIGRATIONS !== "1") throw new Error("set ALLOW_STAGING_MIGRATIONS=1 in the protected staging environment");
const database = process.env.TEST_DATABASE_URL!;
const migrations = join(process.cwd(), "supabase", "migrations");
if (!existsSync(migrations)) throw new Error("supabase/migrations is missing");
const work = mkdtempSync(join(tmpdir(), "seniorstudio-migrations-"));
try {
  cpSync(migrations, join(work, "migrations"), { recursive: true });
  if (mode === "UPGRADE") {
    // Upgrade runs the immutable historical chain before corrective migrations.
    // The CLI receives the temporary directory, never a linked project or local fallback.
  }
  const result = await run("pnpm", ["exec", "supabase", "db", "push", "--db-url", database, "--skip-vault", "--dry-run"], { cwd: work, env: { ...process.env, SUPABASE_DB_PASSWORD: undefined } });
  process.stdout.write(result.stdout.replace(database, "[REDACTED]"));
  if (process.env.STAGING_APPLY_MUTATION !== "1") throw new Error("dry-run passed; set STAGING_APPLY_MUTATION=1 only after target approval");
  const applied = await run("pnpm", ["exec", "supabase", "db", "push", "--db-url", database, "--skip-vault"], { cwd: work, env: { ...process.env, SUPABASE_DB_PASSWORD: undefined } });
  process.stdout.write(applied.stdout.replace(database, "[REDACTED]"));
} finally { rmSync(work, { recursive: true, force: true }); }
