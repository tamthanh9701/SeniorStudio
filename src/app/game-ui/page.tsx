export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import GameUiStylePanel from "@/components/game-ui/GameUiStylePanel";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { listGameUiStyles } from "@/lib/game-ui/service";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export default async function GameUiPage() {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) redirect("/login");

  // Only this domain's styles are listed, and the whole page is server-rendered:
  // a Game UI card needs counts from tables the generic style list route does not
  // read, so a client-side refetch would show fewer numbers than the seed.
  const [{ data: projects }, { data: libraries }, styles] = await Promise.all([
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    supabase.from("style_libraries").select("id, name").order("sort_order").order("name"),
    listGameUiStyles(supabase).catch(() => []),
  ]);
  const libraryList = (libraries ?? []).map((library) => ({ id: library.id as string, name: library.name as string }));

  const sidebar = (
    <ModuleContextSidebar
      currentModule="game_ui"
      userEmail={user.email ?? "Signed in"}
      libraryTabs={libraryList}
      contextLabel="Game UI styles"
    />
  );
  const center = (
    <div className="h-full overflow-y-auto pb-24 xl:pb-0">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
        <div className="mb-8">
          <p className="text-sm font-medium text-primary">Game UI Style</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Interface styles for game screens</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Analyze reference screenshots into reusable interface rules, generate screens from them, then review the detected
            elements and export transparent assets.
          </p>
        </div>
        <GameUiStylePanel initialStyles={styles} libraries={libraryList} />
      </div>
    </div>
  );
  return <StudioShell projects={projects ?? []} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} />;
}
