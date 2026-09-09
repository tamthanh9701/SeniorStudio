import type { SupabaseClient } from "@supabase/supabase-js";

export type StyleSchemaVersionSource = "analysis" | "user_validation" | "tuning" | "manual";

export interface CommitStyleSchemaMutationInput {
  styleId: string;
  expectedUpdatedAt?: string | null;
  source: StyleSchemaVersionSource;
  schema: Record<string, unknown>;
  fingerprint?: Record<string, unknown> | null;
  invariantContract?: Record<string, unknown> | null;
  styleFields?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export async function commitStyleSchemaMutation(client: SupabaseClient, input: CommitStyleSchemaMutationInput) {
  const { data, error } = await client.rpc("commit_style_schema_mutation", {
    p_style_id: input.styleId,
    p_expected_updated_at: input.expectedUpdatedAt ?? null,
    p_source: input.source,
    p_schema: input.schema,
    p_fingerprint: input.fingerprint ?? {},
    p_invariant_contract: input.invariantContract ?? {},
    p_style_fields: input.styleFields ?? {},
    p_metadata: input.metadata ?? {},
  });
  if (error) throw error;
  return data;
}

/** Legacy insert helper retained for existing schema-version consumers. */
export async function appendSchemaVersion(client: SupabaseClient, styleId: string, input: { source: StyleSchemaVersionSource; schema: Record<string, unknown>; metadata?: Record<string, unknown> }) {
  const { data, error } = await client.from("style_schema_versions").insert({ style_id: styleId, source: input.source, schema: input.schema, metadata: input.metadata ?? {} });
  if (error) throw error;
  return data;
}

export async function updateStyleFields(client: SupabaseClient, input: {
  styleId: string;
  expectedUpdatedAt?: string | null;
  name?: string | null;
  status?: string | null;
  libraryId?: string | null;
}) {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.status !== undefined) patch.status = input.status;
  if (input.libraryId !== undefined) patch.library_id = input.libraryId;
  const { data, error } = await client.rpc("update_style_fields", {
    p_style_id: input.styleId,
    p_expected_updated_at: input.expectedUpdatedAt ?? null,
    p_patch: patch,
  });
  if (error) throw error;
  return data;
}

export async function getSchemaVersions(client: SupabaseClient, styleId: string, limit = 20) {
  const { data, error } = await client.from("style_schema_versions").select("*").eq("style_id", styleId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}
