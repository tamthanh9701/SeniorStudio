import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ styleId: string }> }
) {
  const { styleId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { data: style, error: styleError } = await supabase
    .from("styles")
    .select("id, workspace_id")
    .eq("id", styleId)
    .single();

  if (styleError || !style) {
    return NextResponse.json(
      { error: { code: "STYLE_NOT_FOUND", message: "Style not found" } },
      { status: 404 }
    );
  }

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", style.workspace_id)
    .eq("supabase_user_id", user.id)
    .single();

  if (!membership) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Not a member of this workspace" } },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 24);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 24));
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam
    ? (() => {
        try {
          return JSON.parse(Buffer.from(cursorParam, "base64url").toString("utf-8")) as {
            createdAt: string;
            id: string;
          };
        } catch {
          return null;
        }
      })()
    : null;

  const query = supabase
    .from("assets")
    .select("id, name, kind, current_version_id, created_at")
    .eq("style_id", styleId)
    .eq("kind", "generated")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
    );
  }

  const { data: assetRows, error: queryError } = await query;

  if (queryError) {
    return NextResponse.json(
      { error: { code: "LOAD_FAILED", message: "Unable to load assets" } },
      { status: 500 }
    );
  }

  const hasMore = (assetRows?.length ?? 0) > limit;
  const pageAssets = hasMore ? assetRows!.slice(0, limit) : assetRows ?? [];

  if (pageAssets.length === 0) {
    return NextResponse.json({ assets: [], pagination: { nextCursor: null } });
  }

  // Fetch version data for current versions
  const currentVersionIds = pageAssets
    .map((a) => a.current_version_id)
    .filter((id): id is string => id !== null);

  const { data: versions } = currentVersionIds.length > 0
    ? await supabase
        .from("asset_versions")
        .select("id, parent_version_id, storage_path")
        .in("id", currentVersionIds)
    : { data: null };

  const versionById = new Map<string, { parent_version_id: string | null; storage_path: string }>();
  if (versions) {
    for (const v of versions) {
      versionById.set(v.id, v);
    }
  }

  // Fetch source asset IDs from parent versions
  const parentVersionIds = [
    ...new Set(
      pageAssets
        .map((a) => {
          if (!a.current_version_id) return null;
          return versionById.get(a.current_version_id)?.parent_version_id ?? null;
        })
        .filter((id): id is string => id !== null)
    ),
  ];

  let parentToSourceAsset: Record<string, string> = {};
  if (parentVersionIds.length > 0) {
    const { data: parentVersions } = await supabase
      .from("asset_versions")
      .select("id, asset_id")
      .in("id", parentVersionIds);

    if (parentVersions) {
      for (const pv of parentVersions) {
        parentToSourceAsset[pv.id] = pv.asset_id;
      }
    }
  }

  // Build assets array and batch sign URLs
  const assets = await Promise.all(
    pageAssets.map(async (row) => {
      const version = row.current_version_id ? versionById.get(row.current_version_id) : undefined;
      const parentVersionId = version?.parent_version_id ?? null;
      const sourceAssetId = parentVersionId ? (parentToSourceAsset[parentVersionId] ?? null) : null;

      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        currentVersionId: row.current_version_id,
        signedUrl: version?.storage_path ? await getSignedUrl(supabase, version.storage_path) : null,
        createdAt: row.created_at,
        parentVersionId,
        sourceAssetId,
      };
    })
  );

  const nextCursor = hasMore
    ? Buffer.from(
        JSON.stringify({
          createdAt: pageAssets[pageAssets.length - 1].created_at,
          id: pageAssets[pageAssets.length - 1].id,
        })
      ).toString("base64url")
    : null;

  return NextResponse.json({ assets, pagination: { nextCursor } });
}
