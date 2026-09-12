function schemaValue(schema: Record<string, unknown> | null, group: string, keys: string[]) {
  const value = schema?.[group];
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return keys.map((key) => typeof record[key] === "string" ? record[key] : null).filter(Boolean).join(" · ") || null;
}

export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import { getModelCatalog } from "@/lib/ai/models";
import { AiJobSchema, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { getSignedUrl } from "@/lib/assets/service";

export default async function StyleGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ styleId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { styleId } = await params;
  const { tab } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: workspaceMember } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("supabase_user_id", user.id)
    .single();
  const workspaceId = workspaceMember?.workspace_id;

  const [{ data: style }, { data: assets }, modelCatalog, { data: jobs }] = await Promise.all([
    supabase.from("styles").select("id, name, status, schema, updated_at").eq("id", styleId).single(),
    supabase.from("assets").select("id, name, kind, current_version_id, created_at").eq("style_id", styleId).eq("kind", "generated").order("created_at", { ascending: false }),
    workspaceId ? getModelCatalog(supabase, workspaceId) : Promise.resolve([]),
    supabase.from("ai_jobs").select("*").eq("style_id", styleId).eq("module", "style").order("created_at", { ascending: false }).limit(50),
  ]);

  if (!style) notFound();

  const galleryAssets = await Promise.all(
    (assets ?? []).map(async (asset) => {
      if (!asset.current_version_id) return { id: asset.id, name: asset.name, signedUrl: null, versionId: null, createdAt: asset.created_at };
      const { data: version } = await supabase.from("asset_versions").select("id, storage_path, parent_version_id").eq("id", asset.current_version_id).maybeSingle();
      return {
        id: asset.id,
        name: asset.name,
        signedUrl: version ? await getSignedUrl(supabase, version.storage_path) : null,
        versionId: version?.id ?? null,
        createdAt: asset.created_at,
        parentVersionId: version?.parent_version_id ?? null,
      };
    }),
  );

  const parsedJobs = (jobs ?? [])
    .map((job) => AiJobSchema.safeParse(job))
    .filter((result) => result.success)
    .map((result) => result.data)
    .reverse();
  const initialJobs: ProjectJobFeedItem[] = await Promise.all(
    parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })),
  );

  const activeTab = tab || "gallery";

  return (
    <div className="h-dvh overflow-hidden bg-[var(--canvas)] text-[var(--text)]">
      <header className="flex h-14 items-center gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-4">
        <a href="/style" className="text-sm text-[var(--muted)] hover:text-[var(--text)]">Styles</a>
        <span className="text-[var(--muted)]">/</span>
        <h1 className="truncate font-semibold">{style.name}</h1>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${style.status === "active" ? "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]" : "bg-[var(--surface-hover)] text-[var(--muted)]"}`}>
          {style.status === "active" ? "Active" : "Draft"}
        </span>
      </header>
      <div className="flex h-[calc(100dvh-3.5rem)]">
        <nav className="flex w-40 shrink-0 flex-col gap-1 border-r border-[var(--border)] bg-[var(--panel)] p-3">
          <a href={`/style/${styleId}?tab=gallery`} className={`rounded-lg px-3 py-2 text-sm ${activeTab === "gallery" ? "bg-[var(--accent-subtle)] text-[var(--accent)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}>
            Gallery ({galleryAssets.length})
          </a>
          <a href={`/style/${styleId}/new`} className="rounded-lg px-3 py-2 text-sm text-[var(--accent)] hover:text-[var(--accent-hover)]">
            + Tạo ảnh mới
          </a>
          <a href={`/style/${styleId}?tab=style`} className={`rounded-lg px-3 py-2 text-sm ${activeTab === "style" ? "bg-[var(--accent-subtle)] text-[var(--accent)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}>
            Phong cách
          </a>
        </nav>

        <main className="flex-1 overflow-y-auto p-6">
          {activeTab === "gallery" && (
            <div>
              {galleryAssets.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <p className="text-sm text-[var(--muted)]">Chưa có ảnh nào. Bắt đầu tạo ảnh mới.</p>
                  <a href={`/style/${styleId}/new`} className="studio-button-primary mt-4">Tạo ảnh mới</a>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {galleryAssets.map((asset) => <a key={asset.id} href={`/style/${styleId}/assets/${asset.id}`} className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] transition hover:border-[var(--accent)]">{asset.signedUrl ? <img src={asset.signedUrl} alt={asset.name} className="aspect-square w-full object-cover" /> : <div className="flex aspect-square items-center justify-center text-xs text-[var(--muted)]">Empty</div>}<div className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-2 py-1.5 text-xs text-white/80">{asset.name}</div></a>)}
                </div>
              )}
            </div>
          )}

          {activeTab === "style" && (
            <div className="max-w-3xl space-y-5">
              <div><h2 className="text-lg font-semibold">Phong cách trực quan</h2><p className="mt-1 text-sm text-[var(--muted)]">Các quy tắc được phát hiện sẽ định hướng những ảnh tạo tiếp theo.</p></div>
              {style.schema && Object.keys(style.schema).length > 0 ? <>
                <div className="grid gap-3 sm:grid-cols-2"><div className="studio-card p-4"><p className="studio-label">Rendering</p><p className="text-sm">{schemaValue(style.schema, "artistic_style", ["medium", "rendering_style"]) ?? "Not specified"}</p></div><div className="studio-card p-4"><p className="studio-label">Lighting</p><p className="text-sm">{schemaValue(style.schema, "lighting", ["primary_light_source", "light_quality"]) ?? "Not specified"}</p></div><div className="studio-card p-4"><p className="studio-label">Material</p><p className="text-sm">{schemaValue(style.schema, "material_texture", ["primary_material", "surface_finish"]) ?? "Not specified"}</p></div><div className="studio-card p-4"><p className="studio-label">Composition</p><p className="text-sm">{schemaValue(style.schema, "composition", ["framing", "perspective", "crop_style"]) ?? "Not specified"}</p></div></div>
                <details className="studio-card p-4"><summary className="cursor-pointer font-medium">Advanced schema</summary><pre className="mt-4 max-h-96 overflow-auto rounded-xl bg-[var(--surface-hover)] p-4 text-xs text-[var(--muted)]">{JSON.stringify(style.schema, null, 2)}</pre></details>
              </> : <p className="studio-card p-6 text-sm text-[var(--muted)]">Chưa có schema. Hãy upload references và phân tích.</p>}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
