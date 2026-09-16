import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { Download, Paintbrush } from "lucide-react";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";
import VersionHistory from "@/components/editor/VersionHistory";
import ComparisonSlider from "@/components/editor/ComparisonSlider";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { Button } from "@/components/ui/button";
import ExportTransparentDialog from "@/components/style/ExportTransparentDialog";

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
  const sidebar = <ProjectSidebar activeModule="playground" userEmail={user.email ?? "Signed in"} />;
  const center = (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
        <div className="min-w-0">
          <p className="truncate font-semibold">{asset.name}</p>
          <p className="text-xs text-muted-foreground">Immutable asset detail</p>
        </div>
        <div className="flex gap-2">
          {currentVersion && <ExportTransparentDialog assetId={assetId} versionId={currentVersion.id} />}
          {currentVersion?.signedUrl && (
            <Button asChild variant="outline" size="icon">
              <a href={currentVersion.signedUrl} download aria-label="Download current version"><Download className="size-4" /></a>
            </Button>
          )}
          <Button asChild>
            <Link href={`/projects/${projectId}/assets/${assetId}/edit`}><Paintbrush className="size-4" /><span className="hidden sm:inline">Inpaint</span></Link>
          </Button>
        </div>
      </header>
      <div className="checker-stage min-h-0 flex-1 overflow-auto p-4 sm:p-8">
        {currentVersion?.signedUrl && parentVersion?.signedUrl ? (
          <ComparisonSlider beforeUrl={parentVersion.signedUrl} afterUrl={currentVersion.signedUrl} width={currentVersion.width || 800} height={currentVersion.height || 600} />
        ) : currentVersion?.signedUrl ? (
          <Image src={currentVersion.signedUrl} alt={asset.name} width={currentVersion.width || 800} height={currentVersion.height || 600} unoptimized className="mx-auto max-h-full max-w-full rounded-lg object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-stage-muted">No image available</div>
        )}
      </div>
    </div>
  );
  const inspector = <VersionHistory versions={signedVersions} currentVersionId={asset.current_version_id} assetId={assetId} assetHref={`/projects/${projectId}/assets/${assetId}`} />;

  return <StudioShell projects={projects ?? []} activeProjectId={projectId} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} inspector={inspector} />;
}
