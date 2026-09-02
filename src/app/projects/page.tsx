export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";
import ProjectsDashboard from "@/components/studio/ProjectsDashboard";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id, name, created_at, assets(id, current_version_id, created_at)")
    .order("created_at", { ascending: false });

  if (projectsError) throw new Error(`Unable to load projects: ${projectsError.message}`);
  const dashboardProjects = await Promise.all((projects ?? []).map(async (project) => {
    const latestAsset = [...(project.assets ?? [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (!latestAsset?.current_version_id) return { id: project.id, name: project.name, created_at: project.created_at, thumbnailUrl: null };
    const { data: version } = await supabase.from("asset_versions").select("storage_path").eq("id", latestAsset.current_version_id).maybeSingle();
    return { id: project.id, name: project.name, created_at: project.created_at, thumbnailUrl: version ? await getSignedUrl(supabase, version.storage_path) : null };
  }));

  return <ProjectsDashboard projects={dashboardProjects} userEmail={user.email ?? "Signed in"} />;
}
