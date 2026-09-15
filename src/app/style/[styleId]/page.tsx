export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import StyleWorkspace, { type WorkspaceTab } from "@/components/studio/StyleWorkspace";
import { createClient } from "@/supabase/server";
import { getModelCatalog } from "@/lib/ai/models";
import { AiJobSchema, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { getJobResultUrls } from "@/lib/ai/job-results";
import { getStyleSetupState, type StyleSetupState } from "@/lib/style/confirmed-definition";
import { getStyleDetail, listStyleAssets } from "@/lib/style/style-assets";

const WORKSPACE_TABS: readonly WorkspaceTab[] = ["images", "references", "style"];

/** Unconfirmed styles open on the step they still have to finish. */
const TAB_FOR_SETUP_STATE: Record<StyleSetupState, WorkspaceTab> = {
  references: "references",
  analysis: "references",
  review: "style",
  ready: "images",
};

export default async function StyleGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ styleId: string }>;
  searchParams: Promise<{ tab?: string; compose?: string; sourceVersionId?: string }>;
}) {
  const { styleId } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Older links and bookmarks used `tab=gallery`; the gallery is now the Images tab.
  if (query.tab === "gallery") {
    const preserved = new URLSearchParams({ tab: "images" });
    if (query.compose) preserved.set("compose", query.compose);
    if (query.sourceVersionId) preserved.set("sourceVersionId", query.sourceVersionId);
    redirect(`/style/${styleId}?${preserved.toString()}`);
  }

  const { data: workspaceMember } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("supabase_user_id", user.id)
    .single();
  const workspaceId = workspaceMember?.workspace_id;

  // Style, references and the first gallery page are read here so the workspace
  // can render real content on first paint instead of fetching it again.
  const [style, assetsPage, { data: jobs }, modelCatalog] = await Promise.all([
    getStyleDetail(supabase, styleId),
    listStyleAssets(supabase, styleId, { limit: 50 }).catch(() => ({ assets: [], nextCursor: null })),
    supabase.from("ai_jobs").select("*").eq("style_id", styleId).eq("module", "style").order("created_at", { ascending: false }).limit(50),
    workspaceId ? getModelCatalog(supabase, workspaceId) : Promise.resolve([]),
  ]);

  if (!style) notFound();

  const parsedJobs = (jobs ?? [])
    .map((job) => AiJobSchema.safeParse(job))
    .filter((result) => result.success)
    .map((result) => result.data);
  const initialJobs: ProjectJobFeedItem[] = await Promise.all(
    parsedJobs.map(async (job) => ({ job, result_urls: await getJobResultUrls(supabase, job) })),
  );

  // Resolve the variant source here so any version of this style can be
  // varied, regardless of how recently it was generated.
  const sourceVersion = query.sourceVersionId
    ? await supabase
        .from("asset_versions")
        .select("id, prompt, metadata, assets!asset_versions_asset_id_fkey!inner(style_id)")
        .eq("id", query.sourceVersionId)
        .eq("assets.style_id", styleId)
        .maybeSingle()
        .then(({ data }) => {
          if (!data) return null;
          const metadata = (data.metadata ?? {}) as Record<string, unknown>;
          const original = typeof metadata.original_prompt === "string" && metadata.original_prompt.trim() ? metadata.original_prompt : null;
          return { id: data.id, prompt: original, metadata };
        })
    : null;

  const setupState = getStyleSetupState(style, style.references.length);
  const requestedTab = WORKSPACE_TABS.find((tab) => tab === query.tab);
  const initialTab: WorkspaceTab = requestedTab ?? TAB_FOR_SETUP_STATE[setupState];

  return (
    <StyleWorkspace
      styleId={styleId}
      initialTab={initialTab}
      compose={query.compose === "1"}
      sourceVersionId={query.sourceVersionId ?? null}
      initialSourceVersion={sourceVersion}
      models={modelCatalog}
      initialJobs={initialJobs}
      initialDetail={style}
      initialGallery={assetsPage.assets}
    />
  );
}
