export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import GameUiWorkspace, { type GameUiWorkspaceTab } from "@/components/game-ui/GameUiWorkspace";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { getGameUiStyleDetail, listGameUiScreens } from "@/lib/game-ui/service";
import { getStyleSetupState, parseGameUiConfirmedDefinition, type StyleSetupState } from "@/lib/style/confirmed-definition";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const WORKSPACE_TABS: readonly GameUiWorkspaceTab[] = ["references", "style", "screens"];

/** Unconfirmed styles open on the step they still have to finish. */
const TAB_FOR_SETUP_STATE: Record<StyleSetupState, GameUiWorkspaceTab> = {
  references: "references",
  analysis: "references",
  review: "style",
  ready: "screens",
};

export default async function GameUiStylePage({
  params,
  searchParams,
}: {
  params: Promise<{ styleId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { styleId } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) redirect("/login");

  // The workspace renders real content on first paint: the candidate, the
  // reference hashes the staleness check needs and the first screens page are all
  // read before the client component mounts.
  const [style, screensPage, { data: styleRow }, { data: projects }, { data: libraries }] = await Promise.all([
    getGameUiStyleDetail(supabase, styleId).catch(() => null),
    listGameUiScreens(supabase, styleId, { limit: 25 }).catch(() => ({ screens: [], nextCursor: null })),
    supabase
      .from("styles")
      .select("schema, analysis_meta, confirmed_definition, style_references(id, content_hash, retired_at)")
      .eq("id", styleId)
      .maybeSingle(),
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    supabase.from("style_libraries").select("id, name").order("sort_order").order("name"),
  ]);
  if (!style) notFound();

  const analysisMeta = (styleRow?.analysis_meta ?? {}) as Record<string, unknown>;
  const rawSnapshot = Array.isArray(analysisMeta.reference_snapshot) ? analysisMeta.reference_snapshot : null;
  const analysisSnapshot = rawSnapshot
    ? rawSnapshot
        .map((entry) => entry as Record<string, unknown>)
        .filter((entry) => typeof entry.id === "string" && typeof entry.content_hash === "string")
        .map((entry) => ({ id: entry.id as string, content_hash: entry.content_hash as string }))
    : null;
  const referenceHashes: Record<string, string> = {};
  for (const reference of (styleRow?.style_references ?? []) as Array<{ id: string; content_hash: string | null; retired_at: string | null }>) {
    if (reference.retired_at === null && typeof reference.content_hash === "string") referenceHashes[reference.id] = reference.content_hash;
  }
  // A malformed definition must not be read as "unconfirmed"; the client is told
  // there is no comparable snapshot instead of crashing the page.
  let confirmedSchema: unknown = null;
  try {
    confirmedSchema = parseGameUiConfirmedDefinition(styleRow?.confirmed_definition ?? null)?.schema_snapshot ?? null;
  } catch {
    confirmedSchema = null;
  }

  const setupState = getStyleSetupState(
    { status: style.status, schema: styleRow?.schema, analysis_meta: styleRow?.analysis_meta, confirmed_definition: styleRow?.confirmed_definition },
    style.references.length,
  );
  const requestedTab = WORKSPACE_TABS.find((tab) => tab === query.tab);
  const libraryList = (libraries ?? []).map((library) => ({ id: library.id as string, name: library.name as string }));

  const sidebar = (
    <ModuleContextSidebar currentModule="game_ui" userEmail={user.email ?? "Signed in"} contextLabel={style.name} libraryTabs={libraryList} />
  );
  const center = (
    <GameUiWorkspace
      styleId={styleId}
      initialDetail={style}
      initialScreens={screensPage.screens}
      initialScreensCursor={screensPage.nextCursor}
      initialTab={requestedTab ?? TAB_FOR_SETUP_STATE[setupState]}
      initialAnalysisSnapshot={analysisSnapshot}
      initialReferenceHashes={referenceHashes}
      initialConfirmedSchema={confirmedSchema}
    />
  );
  return <StudioShell projects={projects ?? []} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} />;
}
