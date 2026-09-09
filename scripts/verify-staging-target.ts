#!/usr/bin/env tsx
/** Fail-closed verifier for the approved hosted staging target. */
import { Client } from "pg";

const REQUIRED = [
  "STAGING_SUPABASE_PROJECT_REF", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "TEST_DATABASE_URL", "STAGING_APP_URL", "STAGING_VERCEL_PROJECT_ID",
  "VERCEL_ORG_ID", "VERCEL_TOKEN",
] as const;
const PROTECTED_REFS = new Set(["ykcyfzlkpmohipwraqhi"]);
const PROTECTED_VERCEL = new Set(["prj_4ZbNKVe9SI4uUJLws7KsvKWnoqrU"]);

function fail(message: string): never { throw new Error(message); }
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}
function origin(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { fail(`${name} must be an absolute HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    fail(`${name} must be an exact HTTPS origin without credentials or path`);
  return url;
}
function validateTarget() {
  const ref = required("STAGING_SUPABASE_PROJECT_REF");
  if (!/^[a-z0-9]{15,30}$/.test(ref) || PROTECTED_REFS.has(ref)) fail("staging project ref is invalid or protected");
  const supabase = origin(required("NEXT_PUBLIC_SUPABASE_URL"), "NEXT_PUBLIC_SUPABASE_URL");
  if (supabase.hostname !== `${ref}.supabase.co`) fail("Supabase URL does not exactly match staging project ref");
  origin(required("STAGING_APP_URL"), "STAGING_APP_URL");
  const project = required("STAGING_VERCEL_PROJECT_ID");
  if (PROTECTED_VERCEL.has(project)) fail("Vercel project is protected");
  if (!required("NEXT_PUBLIC_SUPABASE_ANON_KEY") || !required("SUPABASE_SERVICE_ROLE_KEY")) fail("missing Supabase credentials");
  return { ref, supabase };
}
function validateDatabase() {
  const raw = required("TEST_DATABASE_URL");
  let url: URL;
  try { url = new URL(raw); } catch { fail("TEST_DATABASE_URL is not a valid PostgreSQL URL"); }
  if (!/^postgres(ql)?:$/.test(url.protocol) || url.username.includes("%") || url.password.includes("%")) fail("TEST_DATABASE_URL must be a PostgreSQL URL");
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) fail("local/IP database targets are forbidden");
  const port = Number(url.port || "5432");
  if (port !== 5432) fail("transaction pooler/ nonstandard database ports are forbidden; use direct or session pooler 5432");
  if (url.hostname.includes("pooler") && !/^postgres\.[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)) fail("database pooler host is not an approved session pooler");
  if (url.hostname.includes("pooler") && !url.username.startsWith("postgres.")) fail("session pooler requires postgres.<project-ref> user");
  const expectedHost = process.env.STAGING_DB_HOST?.trim();
  const expectedUser = process.env.STAGING_DB_USER?.trim();
  const expectedPort = process.env.STAGING_DB_PORT?.trim();
  if (!expectedHost || !expectedUser || !expectedPort) fail("protected expected database host/user/port are required");
  if (url.hostname !== expectedHost || decodeURIComponent(url.username) !== expectedUser || String(port) !== expectedPort) fail("database target does not match protected expected host/user/port");
  const ca = process.env.STAGING_DB_CA ?? process.env.PGSSLROOTCERT;
  if (!ca?.trim()) fail("TLS CA certificate is required; refusing unverifiable database TLS");
  return { connectionString: raw, ssl: { ca, rejectUnauthorized: true } };
}
async function main() {
  const target = validateTarget();
  const db = validateDatabase();
  const client = new Client(db);
  try {
    await client.connect();
    await client.query("select version()");
    await client.query("select version, name from supabase_migrations.schema_migrations order by version");
    for (const path of ["/auth/v1/health", "/storage/v1/bucket"]) {
      const response = await fetch(`${target.supabase.origin}${path}`, { headers: { apikey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY") } });
      if (!response.ok) fail(`Supabase health check failed (${response.status})`);
    }
  } finally { await client.end().catch(() => undefined); }
  console.log(`Staging target verified: ${target.ref}`);
}
main().catch((error: unknown) => { console.error(`Staging verification failed: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; });
