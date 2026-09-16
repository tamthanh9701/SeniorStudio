// Style CRUD routes. RLS scopes every query to the caller's workspaces; the
// flag check keeps the whole surface dark when STYLE_PROFILES_ENABLED=false.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { getStyleSetupState } from "@/lib/style/confirmed-definition";
import { getSignedUrls } from "@/lib/assets/service";

const GetStylesSchema = z.object({
  libraryId: z.string().uuid().optional(),
});

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

/**
 * Cover art for the style cards: the newest generated image, or the first live
 * reference while a style has not generated anything yet. Every path in one
 * signing round-trip — per-image signing was the slow part of this list.
 */
async function loadStyleCovers(supabase: Awaited<ReturnType<typeof createClient>>, styleIds: string[]) {
  const counts = new Map<string, number>();
  const signed = new Map<string, string>();
  if (!styleIds.length) return { counts, signed };
  const { data: assets } = await supabase
    .from("assets")
    .select("style_id, current_version_id, created_at")
    .in("style_id", styleIds)
    .order("created_at", { ascending: false });
  const newestByStyle = new Map<string, string>();
  for (const asset of assets ?? []) {
    const styleId = asset.style_id as string;
    counts.set(styleId, (counts.get(styleId) ?? 0) + 1);
    if (asset.current_version_id && !newestByStyle.has(styleId)) newestByStyle.set(styleId, asset.current_version_id as string);
  }
  const versionPaths = new Map<string, string>();
  if (newestByStyle.size) {
    const { data: versions } = await supabase.from("asset_versions").select("id, storage_path").in("id", [...newestByStyle.values()]);
    for (const version of versions ?? []) versionPaths.set(version.id as string, version.storage_path as string);
  }
  const coverPaths = new Map<string, string>();
  for (const [styleId, versionId] of newestByStyle) {
    const path = versionPaths.get(versionId);
    if (path) coverPaths.set(styleId, path);
  }
  const missing = styleIds.filter((styleId) => !coverPaths.has(styleId));
  if (missing.length) {
    const { data: references } = await supabase
      .from("style_references")
      .select("style_id, storage_path, created_at")
      .in("style_id", missing)
      .is("retired_at", null)
      .order("created_at", { ascending: true });
    for (const reference of references ?? []) {
      const styleId = reference.style_id as string;
      if (!coverPaths.has(styleId)) coverPaths.set(styleId, reference.storage_path as string);
    }
  }
  if (coverPaths.size) {
    const urls = await getSignedUrls(supabase, [...coverPaths.values()]);
    for (const [styleId, path] of coverPaths) {
      const url = urls.get(path);
      if (url) signed.set(styleId, url);
    }
  }
  return { counts, signed };
}
 export async function GET(request: Request) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const params = GetStylesSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  const libraryId = params.success ? params.data.libraryId : undefined;
  const query = supabase
    .from("styles")
    .select("id, name, status, created_at, updated_at, library_id, operability, analysis_meta, confirmed_definition, style_references(id, retired_at)")
    .order("updated_at", { ascending: false });
  if (libraryId) query.eq("library_id", libraryId);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load styles" } }, { status: 500 });
  const { counts, signed } = await loadStyleCovers(supabase, (data ?? []).map((row) => row.id as string));
  const styles = (data ?? []).map((row) => {
    const liveReferences = ((row.style_references ?? []) as Array<{ retired_at: string | null }>).filter((reference) => reference.retired_at === null);
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      referenceCount: liveReferences.length,
      imageCount: counts.get(row.id as string) ?? 0,
      thumbnailUrl: signed.get(row.id as string) ?? null,
      updatedAt: row.updated_at,
      libraryId: row.library_id,
      operability: row.operability,
      setupState: getStyleSetupState(
        { status: row.status, schema: null, analysis_meta: row.analysis_meta, confirmed_definition: row.confirmed_definition },
        liveReferences.length,
      ),
    };
  });
  return NextResponse.json({ styles });
}
const CreateStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  libraryId: z.string().uuid().nullable().optional(),
});
 export async function POST(request: Request) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = CreateStyleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Name must be 1-100 characters" } }, { status: 400 });
  const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
  if (!member) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });
  const { data: style, error } = await supabase
    .from("styles")
    .insert({ workspace_id: member.workspace_id, name: parsed.data.name, library_id: parsed.data.libraryId ?? null })
    .select("id, name, status, created_at, updated_at, library_id")
    .single();
  if (error) return NextResponse.json({ error: { code: "CREATE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ style: { ...style, referenceCount: 0, libraryId: style.library_id, setupState: "references" } }, { status: 201 });
}

