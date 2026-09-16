import type { SupabaseClient } from "@supabase/supabase-js";
import { getSignedUrl } from "@/lib/assets/service";
import { STORAGE_BUCKET } from "@/db/schema";
import { getSchemaVersions } from "./schema-versions";

/**
 * Shared style reads.
 *
 * Both the API routes and the server-rendered workspace page use these, so the
 * page can render the real content on first paint instead of showing a
 * skeleton and fetching the same data again from the browser.
 */

export type StyleReferenceView = {
  id: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  content_hash: string | null;
  created_at: string;
  signed_url: string | null;
};

export type StyleGalleryAsset = {
  id: string;
  name: string;
  kind: string;
  currentVersionId: string | null;
  signedUrl: string | null;
  createdAt: string;
  parentVersionId: string | null;
  sourceAssetId: string | null;
  /** Set when an edit of the current version is waiting for Keep or Discard. */
  pendingVersionId: string | null;
  /** The instruction the user wrote for this image, for recognition and search. */
  originalPrompt: string | null;
};

/** Editable references only: retired rows stay resolvable by snapshot, not listed. */
export async function listLiveStyleReferences(client: SupabaseClient, styleId: string): Promise<StyleReferenceView[]> {
  const { data: references } = await client
    .from("style_references")
    .select("id, storage_path, mime_type, byte_size, width, height, content_hash, created_at")
    .eq("style_id", styleId)
    .is("retired_at", null)
    .order("created_at");
  return Promise.all(
    (references ?? []).map(async (reference) => {
      const { data } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(reference.storage_path, 600);
      const { storage_path: _storagePath, ...metadata } = reference;
      return { ...metadata, signed_url: data?.signedUrl ?? null } as StyleReferenceView;
    }),
  );
}

export async function listStyleAssets(
  client: SupabaseClient,
  styleId: string,
  options: { limit?: number; cursor?: { createdAt: string; id: string } | null } = {},
): Promise<{ assets: StyleGalleryAsset[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 24));
  const query = client
    .from("assets")
    .select("id, name, kind, current_version_id, created_at")
    .eq("style_id", styleId)
    .eq("kind", "generated")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (options.cursor) {
    query.or(`created_at.lt.${options.cursor.createdAt},and(created_at.eq.${options.cursor.createdAt},id.lt.${options.cursor.id})`);
  }
  const { data: assetRows, error } = await query;
  if (error) throw new Error("LOAD_FAILED");
  const hasMore = (assetRows?.length ?? 0) > limit;
  const pageAssets = hasMore ? assetRows!.slice(0, limit) : assetRows ?? [];
  if (pageAssets.length === 0) return { assets: [], nextCursor: null };

  const currentVersionIds = pageAssets.map((asset) => asset.current_version_id).filter((id): id is string => id !== null);
  const { data: versions } = currentVersionIds.length > 0
    ? await client.from("asset_versions").select("id, parent_version_id, storage_path").in("id", currentVersionIds)
    : { data: null };
  const versionById = new Map<string, { parent_version_id: string | null; storage_path: string }>();
  for (const version of versions ?? []) versionById.set(version.id, version);

  const parentVersionIds = [
    ...new Set(
      pageAssets
        .map((asset) => (asset.current_version_id ? versionById.get(asset.current_version_id)?.parent_version_id ?? null : null))
        .filter((id): id is string => id !== null),
    ),
  ];
  const parentToSourceAsset = new Map<string, string>();
  if (parentVersionIds.length > 0) {
    const { data: parentVersions } = await client.from("asset_versions").select("id, asset_id").in("id", parentVersionIds);
    for (const parent of parentVersions ?? []) parentToSourceAsset.set(parent.id, parent.asset_id);
  }

  // A candidate edit is a version whose parent is the current one; it waits for
  // the user to keep or discard it, so the gallery has to show that.
  const { data: candidateVersions } = await client
    .from("asset_versions")
    .select("id, asset_id, parent_version_id, created_at, metadata")
    .in("asset_id", pageAssets.map((asset) => asset.id))
    .order("created_at", { ascending: false });
  const pendingByAsset = new Map<string, string>();
  const promptByAsset = new Map<string, string>();
  for (const version of candidateVersions ?? []) {
    const currentId = pageAssets.find((asset) => asset.id === version.asset_id)?.current_version_id ?? null;
    if (currentId && version.parent_version_id === currentId && version.id !== currentId && !pendingByAsset.has(version.asset_id)) {
      pendingByAsset.set(version.asset_id, version.id);
    }
    const original = (version.metadata as Record<string, unknown> | null)?.original_prompt;
    if (typeof original === "string" && original.trim() && !promptByAsset.has(version.asset_id)) {
      promptByAsset.set(version.asset_id, original.trim());
    }
  }

  const assets = await Promise.all(
    pageAssets.map(async (row) => {
      const version = row.current_version_id ? versionById.get(row.current_version_id) : undefined;
      const parentVersionId = version?.parent_version_id ?? null;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        currentVersionId: row.current_version_id,
        signedUrl: version?.storage_path ? await getSignedUrl(client, version.storage_path) : null,
        createdAt: row.created_at,
        parentVersionId,
        sourceAssetId: parentVersionId ? (parentToSourceAsset.get(parentVersionId) ?? null) : null,
        pendingVersionId: pendingByAsset.get(row.id) ?? null,
        originalPrompt: promptByAsset.get(row.id) ?? null,
      } satisfies StyleGalleryAsset;
    }),
  );

  const last = pageAssets[pageAssets.length - 1];
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url")
    : null;
  return { assets, nextCursor };
}

/** Full style detail as the workspace and the detail route consume it. */
export async function getStyleDetail(client: SupabaseClient, styleId: string) {
  const { data: style } = await client.from("styles").select("*").eq("id", styleId).maybeSingle();
  if (!style) return null;
  const [references, schemaVersions] = await Promise.all([
    listLiveStyleReferences(client, styleId),
    getSchemaVersions(client, styleId),
  ]);
  return { ...style, references, schemaVersions };
}
