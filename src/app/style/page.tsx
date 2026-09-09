export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import { getModelCatalog } from "@/lib/ai/models";
import { AiJobSchema, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { getJobResultUrls } from "@/lib/ai/job-results";
import StyleWorkspace from "@/components/studio/StyleWorkspace";

export default async function StylePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: workspaceMember } = await supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single();
  const workspaceId = workspaceMember?.workspace_id;
  const [{ data: projects }, modelCatalog, { data: jobs }, { data: activeStyles }, { data: libraries }] = await Promise.all([
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    workspaceId ? getModelCatalog(supabase, workspaceId) : Promise.resolve([]),
    supabase
      .from("ai_jobs")
      .select("*")
      .eq("module", "style")
      .not("input->>style_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("styles").select("id, name, status, library_id, reference_count:style_references(id)").eq("status", "active").order("name"),
    supabase.from("style_libraries").select("id, name").order("sort_order").order("name"),
  ]);

  const parsedJobs = (jobs ?? []).map((job) => AiJobSchema.safeParse(job)).filter((result) => result.success).map((result) => result.data).reverse();
  const initialJobs: ProjectJobFeedItem[] = await Promise.all(parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })));
  const activeStyleList = (activeStyles ?? []).map((style) => ({ id: style.id as string, name: style.name as string, libraryId: style.library_id as string | null }));
  const libraryList = (libraries ?? []).map((library) => ({ id: library.id as string, name: library.name as string }));

  return <StyleWorkspace projects={projects ?? []} userEmail={user.email ?? "Signed in"} models={modelCatalog} initialJobs={initialJobs} activeStyles={activeStyleList} libraries={libraryList} />;

}
