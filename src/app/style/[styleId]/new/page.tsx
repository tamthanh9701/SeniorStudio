export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import { getModelCatalog } from "@/lib/ai/models";
import StyleGroupComposer from "@/components/studio/StyleGroupComposer";

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

  const [{ data: style }, { data: workspaceMember }, { data: references }] = await Promise.all([
    supabase.from("styles").select("id, name, status, schema, fingerprint, updated_at").eq("id", styleId).single(),
    supabase.from("workspace_members").select("workspace_id").eq("supabase_user_id", user.id).single(),
    supabase.from("style_references").select("id, storage_path, mime_type, content_hash").eq("style_id", styleId).order("created_at"),
  ]);

  if (!style) redirect("/style");
  if (style.status !== "active") redirect(`/style/${styleId}`);

  const models = workspaceMember ? await getModelCatalog(supabase, workspaceMember.workspace_id) : [];
  const availableModels = models.filter((m) => m.operations.includes("text_to_image") || m.operations.includes("image_to_image"));

  const refData = (references ?? []).map((r) => ({ id: r.id, content_hash: r.content_hash }));

  let sourceVersionData: { id: string; prompt: string | null; metadata: Record<string, unknown> } | null = null;
  if (sourceVersionId) {
    const { data: sv } = await supabase.from("asset_versions").select("id, prompt, metadata").eq("id", sourceVersionId).single();
    if (sv) sourceVersionData = { id: sv.id, prompt: sv.prompt, metadata: (sv.metadata ?? {}) as Record<string, unknown> };
  }

  return (
    <StyleGroupComposer
      styleName={style.name}
      styleId={styleId}
      schema={style.schema as Record<string, unknown>}
      models={availableModels}
      references={refData}
      sourceVersion={sourceVersionData}
    />
  );
}
