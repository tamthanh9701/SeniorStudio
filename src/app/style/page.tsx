export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import StylePanel from "@/components/studio/StylePanel";
import StudioShell from "@/components/studio/StudioShell";
import { AiJobSchema, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { createClient } from "@/supabase/server";

export default async function StylePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: projects }, { data: jobs }, { data: libraries }] = await Promise.all([
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    supabase.from("ai_jobs").select("*").eq("module", "style").not("input->>style_id", "is", null).order("created_at", { ascending: false }).limit(50),
    supabase.from("style_libraries").select("id, name").order("sort_order").order("name"),
  ]);

  const parsedJobs = (jobs ?? []).map((job) => AiJobSchema.safeParse(job)).filter((result) => result.success).map((result) => result.data).reverse();
  const initialJobs: ProjectJobFeedItem[] = await Promise.all(parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })));
  const libraryList = (libraries ?? []).map((library) => ({ id: library.id as string, name: library.name as string }));
  const sidebar = <ModuleContextSidebar currentModule="style" userEmail={user.email ?? "Signed in"} recentJobs={initialJobs} libraryTabs={libraryList} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0"><div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10"><div className="mb-8"><p className="text-sm font-medium text-[var(--accent)]">Style Groups</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Reusable visual systems</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">Create a shared style from references, review its rules, and use it consistently across new images.</p></div><StylePanel /></div></div>;
  return <StudioShell projects={projects ?? []} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} />;

}
