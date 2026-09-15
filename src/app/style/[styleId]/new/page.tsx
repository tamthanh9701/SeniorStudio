export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";

/**
 * Composition moved into the style workspace.  This route keeps existing links
 * (including variant links carrying `sourceVersionId`) working by validating
 * ownership and forwarding to the workspace, rather than hosting a second
 * generation UI.
 */
export default async function StyleNewImagePage({
  params,
  searchParams,
}: {
  params: Promise<{ styleId: string }>;
  searchParams: Promise<{ sourceVersionId?: string }>;
}) {
  const { styleId } = await params;
  const { sourceVersionId } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: style } = await supabase.from("styles").select("id").eq("id", styleId).maybeSingle();
  if (!style) redirect("/style");

  const query = new URLSearchParams({ tab: "images", compose: "1" });
  if (sourceVersionId) {
    // An unknown or foreign source version must not silently become a plain
    // new image, so the workspace is told whether the variant is usable.
    const { data: source } = await supabase
      .from("asset_versions")
      .select("id, assets!inner(style_id)")
      .eq("id", sourceVersionId)
      .maybeSingle();
    if (source) query.set("sourceVersionId", sourceVersionId);
  }
  redirect(`/style/${styleId}?${query.toString()}`);
}
