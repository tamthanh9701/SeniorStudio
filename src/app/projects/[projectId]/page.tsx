export const dynamic = "force-dynamic";

import { styleProfilesEnabled } from "@/lib/style/flag";

import { notFound, redirect } from "next/navigation";
import { getSignedUrl } from "@/lib/assets/service";
import { createClient } from "@/supabase/server";
import { getModelCatalog } from "@/lib/ai/models";
import { AiJobSchema, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { getJobResultUrls } from "@/lib/ai/job-results";
import ProjectWorkspace from "@/components/studio/ProjectWorkspace";

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: project, error: projectError }, { data: projects }, { data: assets, error: assetsError }, modelCatalog, { data: jobs }] = await Promise.all([
    supabase.from("projects").select("id, name, created_at").eq("id", projectId).maybeSingle(),
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    supabase.from("assets").select("id, name, kind, current_version_id, created_at").eq("project_id", projectId).order("created_at", { ascending: false }),
    getModelCatalog(supabase),
    supabase.from("ai_jobs").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(50),
  ]);
  if (projectError) throw new Error(`Unable to load project: ${projectError.message}`);
  if (!project) notFound();
  if (assetsError) throw new Error(`Unable to load project assets: ${assetsError.message}`);

  const galleryAssets = await Promise.all((assets ?? []).map(async (asset) => {
    if (!asset.current_version_id) return { id: asset.id, name: asset.name, signedUrl: null, versionId: null, width: null, height: null, createdAt: asset.created_at };
    const { data: version, error: versionError } = await supabase.from("asset_versions").select("id, storage_path, width, height").eq("id", asset.current_version_id).maybeSingle();
    if (versionError) throw new Error(`Unable to load asset version: ${versionError.message}`);
    return { id: asset.id, name: asset.name, signedUrl: version ? await getSignedUrl(supabase, version.storage_path) : null, versionId: version?.id ?? null, width: version?.width ?? null, height: version?.height ?? null, createdAt: asset.created_at };
  }));
  const parsedJobs = (jobs ?? []).map((job) => AiJobSchema.safeParse(job)).filter((result) => result.success).map((result) => result.data).reverse();
  const initialJobs: ProjectJobFeedItem[] = await Promise.all(parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })));

  return <ProjectWorkspace key={project.id} project={project} projects={projects ?? []} userEmail={user.email ?? "Signed in"} assets={galleryAssets} models={modelCatalog} initialJobs={initialJobs} styleProfilesEnabled={styleProfilesEnabled()} />;
}
