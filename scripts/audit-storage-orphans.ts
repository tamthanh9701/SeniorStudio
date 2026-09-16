#!/usr/bin/env tsx
/**
 * Read-only audit of the `assets` Storage bucket: it lists every object under a
 * workspace prefix that no database row references, so an operator can find the
 * objects left behind by failed uploads or interrupted persistence. It audits
 * only and deletes nothing — pruning stays a deliberate, manual step.
 *
 * Referenced means the path appears in `style_references.storage_path`,
 * `asset_versions.storage_path` or `ai_job_inputs.storage_path` of the workspace.
 *
 * usage: pnpm exec tsx scripts/audit-storage-orphans.ts <workspace-id|workspace/prefix> [--limit <recursion-depth>]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "assets";
const PAGE_SIZE = 1000;
const LIST_PAGE_SIZE = 100;
const DEFAULT_MAX_DEPTH = 10;
const USAGE = "usage: pnpm exec tsx scripts/audit-storage-orphans.ts <workspace-id|workspace/prefix> [--limit <recursion-depth>]";

function fail(message: string): never { throw new Error(message); }
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}

function parseArguments(argv: string[]): { prefix: string; maxDepth: number } {
  const positional: string[] = [];
  let maxDepth = DEFAULT_MAX_DEPTH;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--limit") {
      const raw = argv[index + 1];
      const depth = Number(raw);
      if (!raw || !Number.isInteger(depth) || depth < 1 || depth > 32) fail(`--limit needs an integer recursion depth between 1 and 32. ${USAGE}`);
      maxDepth = depth;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) fail(`unknown option ${argument}. ${USAGE}`);
    positional.push(argument);
  }
  if (positional.length !== 1) fail(USAGE);
  const prefix = positional[0].replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("//") || prefix.includes("..")) fail(`workspace prefix is not a valid storage prefix. ${USAGE}`);
  return { prefix, maxDepth };
}

type RawPage = { data: unknown; error: { message: string } | null };

/** Page a PostgREST query so workspaces with more than one page of rows are complete. */
async function collectStrings(label: string, column: "id" | "storage_path", query: (from: number, to: number) => PromiseLike<RawPage>): Promise<string[]> {
  const values: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await query(from, from + PAGE_SIZE - 1);
    if (error) fail(`${label} query failed: ${error.message}`);
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) { const value = row[column]; if (typeof value === "string" && value) values.push(value); }
    if (rows.length < PAGE_SIZE) return values;
  }
}

async function referencedPaths(client: SupabaseClient, workspaceId: string, prefix: string): Promise<Set<string>> {
  const scoped = (paths: string[]) => paths.filter((path) => path === prefix || path.startsWith(`${prefix}/`));
  const projectIds = await collectStrings("projects", "id", (from, to) =>
    client.from("projects").select("id").eq("workspace_id", workspaceId).order("id").range(from, to));
  const styleIds = await collectStrings("styles", "id", (from, to) =>
    client.from("styles").select("id").eq("workspace_id", workspaceId).order("id").range(from, to));
  // assets carry no workspace_id: they belong to the workspace through a project or a style.
  const assetIds = new Set<string>();
  for (const [column, owners] of [["project_id", projectIds], ["style_id", styleIds]] as const) {
    for (let index = 0; index < owners.length; index += 100) {
      const page = owners.slice(index, index + 100);
      for (const id of await collectStrings("assets", "id", (from, to) =>
        client.from("assets").select("id").in(column, page).order("id").range(from, to))) assetIds.add(id);
    }
  }
  const references: string[] = [];
  for (let index = 0; index < styleIds.length; index += 100) {
    const page = styleIds.slice(index, index + 100);
    references.push(...await collectStrings("style_references", "storage_path", (from, to) =>
      client.from("style_references").select("storage_path").in("style_id", page).order("id").range(from, to)));
  }
  const versions: string[] = [];
  const versionOwners = [...assetIds];
  for (let index = 0; index < versionOwners.length; index += 100) {
    const page = versionOwners.slice(index, index + 100);
    versions.push(...await collectStrings("asset_versions", "storage_path", (from, to) =>
      client.from("asset_versions").select("storage_path").in("asset_id", page).order("id").range(from, to)));
  }
  const jobInputs = await collectStrings("ai_job_inputs", "storage_path", (from, to) =>
    client.from("ai_job_inputs").select("storage_path").eq("workspace_id", workspaceId).order("id").range(from, to));
  return new Set([...scoped(references), ...scoped(versions), ...scoped(jobInputs)]);
}

/** Supabase Storage returns folders as entries with a null id; recurse into those. */
async function listObjects(client: SupabaseClient, prefix: string, maxDepth: number): Promise<string[]> {
  const objects: string[] = [];
  async function walk(folder: string, depth: number): Promise<void> {
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const { data, error } = await client.storage.from(BUCKET).list(folder, { limit: LIST_PAGE_SIZE, offset });
      if (error) fail(`storage list failed for ${folder}: ${error.message}`);
      const entries = data ?? [];
      for (const entry of entries) {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) { if (depth < maxDepth) await walk(path, depth + 1); continue; }
        objects.push(path);
      }
      if (entries.length < LIST_PAGE_SIZE) return;
    }
  }
  await walk(prefix, 0);
  return objects;
}

async function main(): Promise<void> {
  if (process.argv.length <= 2) fail(USAGE);
  const { prefix, maxDepth } = parseArguments(process.argv.slice(2));
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const referenced = await referencedPaths(client, prefix.split("/")[0], prefix);
  const objects = await listObjects(client, prefix, maxDepth);
  const orphans = objects.filter((path) => !referenced.has(path)).sort();
  console.log(`Storage audit (read-only, nothing is deleted): bucket=${BUCKET} prefix=${prefix} depth=${maxDepth} objects=${objects.length} referenced=${referenced.size}`);
  for (const path of orphans) console.log(path);
  console.log(`orphans=${orphans.length}`);
}

main().catch((error: unknown) => {
  console.error(`Storage audit failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
