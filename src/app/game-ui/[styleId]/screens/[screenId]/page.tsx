export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import ScreenWorkspace from "@/components/game-ui/ScreenWorkspace";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { getGameUiScreen, getGameUiStyleDetail, listGameUiRenders } from "@/lib/game-ui/service";
import { getModelCatalog } from "@/lib/ai/models";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { AiJobSchema, FEED_COLUMNS, FEED_LIMIT, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export default async function GameUiScreenPage({ params }: { params: Promise<{ styleId: string; screenId: string }> }) {
  const { styleId, screenId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) redirect("/login");

  const [record, style, rendersPage, { data: member }, { data: projects }, { data: libraries }, { data: jobs }] = await Promise.all([
    getGameUiScreen(supabase, screenId).catch(() => null),
    getGameUiStyleDetail(supabase, styleId).catch(() => null),
    listGameUiRenders(supabase, screenId, { limit: 25 }).catch(() => ({ renders: [], nextCursor: null })),
    supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).maybeSingle(),
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    supabase.from("style_libraries").select("id, name").order("sort_order").order("name"),
    supabase.from("ai_jobs").select(FEED_COLUMNS).eq("style_id", styleId).eq("module", "style").order("created_at", { ascending: false }).limit(FEED_LIMIT),
  ]);
  // The screen belongs to the style in the URL: a mismatch is a foreign page, not a redirect.
  if (!record || !style || record.styleId !== styleId) notFound();

  const workspaceId = member?.workspace_id;
  const modelCatalog = workspaceId ? await getModelCatalog(getServiceClient(), workspaceId) : [];

  // The wireframe's decoded size is read here so the composer can compare it with
  // the output ratio before the provider is called.
  const wireframeVersionId = record.screen.wireframeVersionId;
  const { data: wireframeVersion } = wireframeVersionId
    ? await supabase.from("asset_versions").select("width, height").eq("id", wireframeVersionId).maybeSingle()
    : { data: null };

  const parsedJobs = (jobs ?? [])
    .map((job) => AiJobSchema.safeParse(job))
    .filter((result) => result.success)
    .map((result) => result.data);
  const initialJobs: ProjectJobFeedItem[] = await Promise.all(
    parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })),
  );

  const libraryList = (libraries ?? []).map((library) => ({ id: library.id as string, name: library.name as string }));
  const sidebar = (
    <ModuleContextSidebar currentModule="game_ui" userEmail={user.email ?? "Signed in"} contextLabel={record.screen.name} libraryTabs={libraryList} />
  );
  const center = (
    <ScreenWorkspace
      styleId={styleId}
      screen={record.screen}
      initialRenders={rendersPage.renders}
      initialRendersCursor={rendersPage.nextCursor}
      wireframeDimensions={
        wireframeVersion && typeof wireframeVersion.width === "number" && typeof wireframeVersion.height === "number"
          ? { width: wireframeVersion.width, height: wireframeVersion.height }
          : null
      }
      references={style.references}
      models={modelCatalog}
      initialJobs={initialJobs}
    />
  );
  return <StudioShell projects={projects ?? []} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} />;
}
