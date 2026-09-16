export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import StylePanel from "@/components/studio/StylePanel";
import StudioShell from "@/components/studio/StudioShell";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export default async function StylePage({ searchParams }: { searchParams: Promise<{ deleted?: string; images?: string; references?: string }> }) {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) redirect("/login");
  const query = await searchParams;
  // The style workspace unmounts on the way here, so it hands the confirmation
  // over as a query parameter instead of losing it with its own state.
  const notice = query.deleted
    ? `Deleted ${query.deleted}: ${Number(query.images) || 0} images, ${Number(query.references) || 0} references.`
    : null;

  // The sidebar answers "which style do I continue?"; a job feed here would be
  // fetched, url-signed and then never shown.
  const [{ data: projects }, { data: libraries }, { data: styles }] = await Promise.all([
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    supabase.from("style_libraries").select("id, name").order("sort_order").order("name"),
    supabase.from("styles").select("id, name, updated_at, assets(count)").order("updated_at", { ascending: false }).limit(6),
  ]);
  const libraryList = (libraries ?? []).map((library) => ({ id: library.id as string, name: library.name as string }));
  const recentStyles = (styles ?? []).map((style) => ({
    id: style.id as string,
    name: style.name as string,
    imageCount: (style.assets as Array<{ count: number }> | null)?.[0]?.count ?? 0,
  }));
  const sidebar = <ModuleContextSidebar currentModule="style" userEmail={user.email ?? "Signed in"} libraryTabs={libraryList} recentStyles={recentStyles} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0"><div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10"><div className="mb-8"><p className="text-sm font-medium text-primary">Style Groups</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Reusable visual systems</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Create a shared style from references, review its rules, and use it consistently across new images.</p></div><StylePanel notice={notice} /></div></div>;
  return <StudioShell projects={projects ?? []} userEmail={user.email ?? "Signed in"} leftSidebar={sidebar} center={center} />;

}
