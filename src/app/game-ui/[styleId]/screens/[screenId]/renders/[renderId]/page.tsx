export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { RenderWorkspace } from "@/components/game-ui/ElementEditor";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { getGameUiRenderDetail, getGameUiScreen } from "@/lib/game-ui/service";
import { getModelCatalog } from "@/lib/ai/models";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export default async function GameUiRenderPage({
  params,
  searchParams,
}: {
  params: Promise<{ styleId: string; screenId: string; renderId: string }>;
  searchParams: Promise<{ outputsCursor?: string }>;
}) {
  const { styleId, screenId, renderId } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) redirect("/login");

  // The map, its spec snapshot and the outputs of this exact image are read
  // together: the render is immutable, so its own snapshot is the authority and a
  // later style change cannot move the boxes.
  const [detail, record, { data: member }, { data: projects }, { data: libraries }] = await Promise.all([
    getGameUiRenderDetail(supabase, renderId, query.outputsCursor ?? null).catch(() => null),
    getGameUiScreen(supabase, screenId).catch(() => null),
    supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).maybeSingle(),
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    supabase.from("style_libraries").select("id, name").order("sort_order").order("name"),
  ]);
  if (!detail || !record || detail.render.screenId !== screenId || record.styleId !== styleId) notFound();

  const workspaceId = member?.workspace_id;
  const modelCatalog = workspaceId ? await getModelCatalog(getServiceClient(), workspaceId) : [];
  const libraryList = (libraries ?? []).map((library) => ({ id: library.id as string, name: library.name as string }));

  const sidebar = (
    <ModuleContextSidebar currentModule="game_ui" userEmail={user.email ?? "Signed in"} contextLabel={record.screen.name} libraryTabs={libraryList} />
  );
  const center = (
    <RenderWorkspace
      styleId={styleId}
      screenId={screenId}
      screenName={record.screen.name}
      render={detail.render}
      spec={detail.spec}
      initialElementSet={detail.elementSet}
      initialOutputs={detail.outputs}
      initialOutputsCursor={detail.outputsNextCursor}
      models={modelCatalog}
    />
  );
  return <StudioShell projects={projects ?? []} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} />;
}
