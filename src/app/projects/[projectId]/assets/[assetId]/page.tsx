import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Download, Paintbrush } from "lucide-react";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";
import VersionHistory from "@/components/editor/VersionHistory";
import ComparisonSlider from "@/components/editor/ComparisonSlider";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; assetId: string }>;
 }) {
  const { projectId, assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [{ data: asset, error: assetError }, { data: projects }] = await Promise.all([
    supabase.from("assets").select("*").eq("id", assetId).eq("project_id", projectId).single(),
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
  ]);
  if (assetError || !asset) notFound();
  const { data: versions } = await supabase.from("asset_versions").select("*").eq("asset_id", assetId).order("created_at", { ascending: true });

  const signedVersions = await Promise.all((versions ?? []).map(async (version) => ({ ...version, signedUrl: await getSignedUrl(supabase, version.storage_path) })));
  const currentVersion = signedVersions.find((version) => version.id === asset.current_version_id) ?? signedVersions.at(-1) ?? null;
  const parentVersion = currentVersion?.parent_version_id ? signedVersions.find((version) => version.id === currentVersion.parent_version_id) ?? null : null;
  const sidebar = <ProjectSidebar projects={projects ?? []} activeProjectId={projectId} userEmail={user.email ?? "Signed in"} />;
  const center = <div className="flex h-full flex-col overflow-hidden"><header className="flex min-h-16 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6"><div className="min-w-0"><p className="truncate font-semibold">{asset.name}</p><p className="text-xs text-[#667085]">Immutable asset detail</p></div><div className="flex gap-2">{currentVersion?.signedUrl && <a href={currentVersion.signedUrl} download className="studio-icon-button" aria-label="Download current version"><Download className="size-4" /></a>}<Link href={`/projects/${projectId}/assets/${assetId}/edit`} className="studio-button-primary"><Paintbrush className="size-4" /><span className="hidden sm:inline">Inpaint</span></Link></div></header><div className="checker-stage min-h-0 flex-1 overflow-auto p-4 sm:p-8">{currentVersion?.signedUrl && parentVersion?.signedUrl ? <ComparisonSlider beforeUrl={parentVersion.signedUrl} afterUrl={currentVersion.signedUrl} width={currentVersion.width || 800} height={currentVersion.height || 600} /> : currentVersion?.signedUrl ? <img src={currentVersion.signedUrl} alt={asset.name} className="mx-auto max-h-full max-w-full rounded-2xl object-contain" /> : <div className="flex h-full items-center justify-center text-[#98a2b3]">No image available</div>}</div></div>;
  const inspector = <VersionHistory versions={signedVersions} currentVersionId={asset.current_version_id} projectId={projectId} assetId={assetId} />;

  return <StudioShell projects={projects ?? []} activeProjectId={projectId} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} inspector={inspector} />;
}
