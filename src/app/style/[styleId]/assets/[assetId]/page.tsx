export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Download, Paintbrush } from "lucide-react";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";

export default async function StyleAssetDetailPage({
  params,
}: {
  params: Promise<{ styleId: string; assetId: string }>;
}) {
  const { styleId, assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: asset } = await supabase
    .from("assets")
    .select("id, name, kind, current_version_id, created_at")
    .eq("id", assetId)
    .eq("style_id", styleId)
    .single();
  if (!asset) notFound();

  const { data: versions } = await supabase
    .from("asset_versions")
    .select("id, storage_path, width, height, prompt, parent_version_id, metadata, source, created_at")
    .eq("asset_id", assetId)
    .order("created_at", { ascending: true });

  const signedVersions = await Promise.all(
    (versions ?? []).map(async (version) => ({
      ...version,
      signedUrl: await getSignedUrl(supabase, version.storage_path),
    })),
  );
  const currentVersion = signedVersions.find((v) => v.id === asset.current_version_id) ?? signedVersions.at(-1) ?? null;
  const parentVersion = currentVersion?.parent_version_id
    ? signedVersions.find((v) => v.id === currentVersion.parent_version_id) ?? null
    : null;

  const sidebar = (
    <div className="space-y-3 p-4">
      <h2 className="font-semibold">Asset Info</h2>
      <div className="space-y-2 text-sm text-[#98a2b3]">
        <p><span className="text-[#667085]">Name:</span> {asset.name}</p>
        <p><span className="text-[#667085]">Created:</span> {new Date(asset.created_at).toLocaleString()}</p>
        {currentVersion?.prompt && (
          <div>
            <p className="text-[#667085]">Prompt:</p>
            <p className="mt-1 whitespace-pre-wrap text-xs">{currentVersion.prompt}</p>
          </div>
        )}
        {parentVersion && (
          <div>
            <p className="text-[#667085]">Source:</p>
            <Link href={`/style/${styleId}/assets/${assetId}`} className="text-xs text-[#7c5cff] hover:underline">parent version</Link>
          </div>
        )}
        <p><span className="text-[#667085]">Versions:</span> {signedVersions.length}</p>
      </div>
    </div>
  );

  return (
    <div className="h-dvh overflow-hidden bg-[#0b0d10] text-[#f5f7fa]">
      <header className="flex h-14 items-center gap-4 border-b border-white/10 bg-[#111419] px-4">
        <Link href={`/style/${styleId}`} className="text-sm text-[#98a2b3] hover:text-white">{styleId}</Link>
        <span className="text-[#667085]">/</span>
        <h1 className="truncate font-semibold">{asset.name}</h1>
        <div className="ml-auto flex gap-2">
          {currentVersion?.signedUrl && (
            <a href={currentVersion.signedUrl} download className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20">
              <Download className="size-3.5" /> Download
            </a>
          )}
          <Link href={`/style/${styleId}/assets/${assetId}/edit`} className="flex items-center gap-1 rounded-lg bg-[#7c5cff] px-3 py-1.5 text-xs text-white hover:bg-[#6b4ee0]">
            <Paintbrush className="size-3.5" /> Inpaint
          </Link>
        </div>
      </header>

      <div className="flex h-[calc(100dvh-3.5rem)]">
        <main className="flex-1 overflow-auto p-6">
          {currentVersion?.signedUrl ? (
            <div className="flex justify-center">
              <img src={currentVersion.signedUrl} alt={asset.name} className="max-h-[70vh] max-w-full rounded-xl object-contain" />
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-[#667085]">Preview unavailable</div>
          )}

          {signedVersions.length > 1 && (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-medium text-[#98a2b3]">Version History</h3>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
                {signedVersions.map((version) => (
                  <div key={version.id} className={`relative overflow-hidden rounded-lg border ${version.id === currentVersion?.id ? "border-[#7c5cff]" : "border-white/10"}`}>
                    {version.signedUrl ? (
                      <img src={version.signedUrl} alt="" className="aspect-square w-full object-cover" />
                    ) : (
                      <div className="aspect-square flex items-center justify-center text-[10px] text-[#667085]">-</div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5 text-center text-[9px] text-white/70">
                      {version.source}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
        <aside className="hidden w-64 shrink-0 border-l border-white/10 bg-[#111419] xl:block">
          {sidebar}
        </aside>
      </div>
    </div>
  );
}
