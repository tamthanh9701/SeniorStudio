export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import { getSignedUrls } from "@/lib/assets/service";
import ProjectsDashboard from "@/components/studio/ProjectsDashboard";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id, name, created_at, updated_at, assets(id, current_version_id, created_at)")
    .order("updated_at", { ascending: false });

  if (projectsError) throw new Error(`Unable to load projects: ${projectsError.message}`);
  const rows = projects ?? [];
  // One query per table plus one signing round-trip for the whole grid, instead
  // of a version lookup and a signed URL per project.
  const newestVersionByProject = new Map<string, string>();
  for (const project of rows) {
    const latestAsset = [...(project.assets ?? [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (latestAsset?.current_version_id) newestVersionByProject.set(project.id, latestAsset.current_version_id);
  }
  const pathByVersion = new Map<string, string>();
  if (newestVersionByProject.size) {
    const { data: versions } = await supabase.from("asset_versions").select("id, storage_path").in("id", [...newestVersionByProject.values()]);
    for (const version of versions ?? []) pathByVersion.set(version.id, version.storage_path);
  }
  const signedUrls = await getSignedUrls(supabase, [...pathByVersion.values()]);
  const dashboardProjects = rows.map((project) => {
    const path = pathByVersion.get(newestVersionByProject.get(project.id) ?? "");
    return { id: project.id, name: project.name, created_at: project.created_at, updated_at: project.updated_at, thumbnailUrl: (path ? signedUrls.get(path) : null) ?? null };
  });

  return <ProjectsDashboard projects={dashboardProjects} userEmail={user.email ?? "Signed in"} />;
}
