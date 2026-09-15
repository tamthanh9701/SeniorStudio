export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Download, GitCompare, Info, Paintbrush, Sparkles } from "lucide-react";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";
import ComparisonSlider from "@/components/editor/ComparisonSlider";
import VersionHistory from "@/components/editor/VersionHistory";
import VersionReviewActions from "@/components/editor/VersionReviewActions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format/datetime";

/** Reads an optional string out of the untyped jsonb provenance columns. */
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

type VersionRow = {
  id: string;
  storage_path: string;
  width: number | null;
  height: number | null;
  prompt: string | null;
  parent_version_id: string | null;
  metadata: Record<string, unknown> | null;
  style_generation: Record<string, unknown> | null;
  source: string;
  created_at: string;
};

type SignedVersion = VersionRow & { signedUrl: string | null };

/** A resolved parent keeps the asset it belongs to so cross-asset sources stay linkable. */
type ResolvedParent = SignedVersion & { asset_id: string };

export default async function StyleAssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ styleId: string; assetId: string }>;
  searchParams: Promise<{ version?: string; review?: string }>;
}) {
  const { styleId, assetId } = await params;
  const { version: versionParam, review: reviewParam } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: asset }, { data: style }] = await Promise.all([
    supabase
      .from("assets")
      .select("id, name, current_version_id, created_at")
      .eq("id", assetId)
      .eq("style_id", styleId)
      .single(),
    supabase.from("styles").select("id, name").eq("id", styleId).single(),
  ]);
  if (!asset) notFound();
  const styleName = text(style?.name) ?? "Style";

  const { data: versionRows } = await supabase
    .from("asset_versions")
    .select("id, storage_path, width, height, prompt, parent_version_id, metadata, style_generation, source, created_at")
    .eq("asset_id", assetId)
    .order("created_at", { ascending: true });

  const sign = async (storagePath: string) => {
    try {
      return await getSignedUrl(supabase, storagePath);
    } catch {
      return null;
    }
  };
  const versions: SignedVersion[] = await Promise.all(
    ((versionRows ?? []) as VersionRow[]).map(async (version) => ({ ...version, signedUrl: await sign(version.storage_path) })),
  );

  const currentVersion = versions.find((version) => version.id === asset.current_version_id) ?? null;
  const requestedVersion = versionParam ? versions.find((version) => version.id === versionParam) ?? null : null;
  const selected = requestedVersion ?? currentVersion ?? versions.at(-1) ?? null;
  const versionFallback = Boolean(versionParam) && requestedVersion === null;
  const candidate = Boolean(selected) && selected?.id !== asset.current_version_id;
  const reviewing = reviewParam === "1" || reviewParam === "true";

  // The comparison is always against this version's exact recorded parent, which
  // may live on another asset of the same style for historical cross-asset results.
  let parent: ResolvedParent | null = null;
  let comparisonNotice: string | null = null;
  if (selected) {
    if (!selected.parent_version_id) {
      comparisonNotice = "This version has no parent version, so there is nothing to compare it against.";
    } else {
      const { data: parentRow } = await supabase
        .from("asset_versions")
        .select("id, storage_path, width, height, prompt, parent_version_id, metadata, style_generation, source, created_at, asset_id")
        .eq("id", selected.parent_version_id)
        .maybeSingle();
      if (!parentRow) {
        comparisonNotice = "The parent version recorded for this edit is no longer available, so the comparison is disabled.";
      } else {
        const { data: parentAsset } = await supabase
          .from("assets")
          .select("id, style_id")
          .eq("id", parentRow.asset_id)
          .maybeSingle();
        if (!parentAsset || parentAsset.style_id !== styleId) {
          comparisonNotice = "The parent version belongs to a different style, so the comparison is disabled.";
        } else {
          parent = { ...(parentRow as ResolvedParent), signedUrl: await sign(parentRow.storage_path) };
        }
      }
    }
  }
  const comparisonAvailable = Boolean(selected?.signedUrl && parent?.signedUrl);
  if (parent && !parent.signedUrl) comparisonNotice = "The parent version preview could not be loaded, so the comparison is disabled.";

  const metadata = selected?.metadata ?? null;
  const packet = selected?.style_generation ?? null;
  const provider = text(metadata?.provider);
  const model = text(metadata?.model);
  const operation = text(metadata?.operation);
  const styleRevision = text(packet?.style_revision);
  const referenceSnapshot = packet?.reference_snapshot;
  const referenceCount = Array.isArray(referenceSnapshot) ? referenceSnapshot.length : null;
  const packetMetadata = packet?.metadata && typeof packet.metadata === "object" ? (packet.metadata as Record<string, unknown>) : null;
  const adoptedCurrentStyle = packetMetadata?.style_provenance === "current_style_fallback";
  const sourceVersionId = text(metadata?.source_version_id) ?? selected?.parent_version_id ?? null;
  const sourceAssetId = text(metadata?.source_asset_id) ?? (parent && parent.id === sourceVersionId ? parent.asset_id : null);
  const sourceHref = sourceVersionId && sourceAssetId ? `/style/${styleId}/assets/${sourceAssetId}?version=${sourceVersionId}` : null;

  const provenance: Array<{ label: string; value: string }> = [];
  if (provider) provenance.push({ label: "Provider", value: provider });
  if (model) provenance.push({ label: "Model", value: model });
  if (operation) provenance.push({ label: "Operation", value: operation });
  if (styleRevision) provenance.push({ label: "Style revision", value: styleRevision.slice(0, 8) });
  if (referenceCount !== null) provenance.push({ label: "References", value: `${referenceCount} used` });

  const historyVersions = versions.map((version) => ({
    id: version.id,
    source: version.source,
    prompt: version.prompt,
    created_at: version.created_at,
    parent_version_id: version.parent_version_id,
    metadata: {
      provider: text(version.metadata?.provider) ?? undefined,
      model: text(version.metadata?.model) ?? undefined,
      operation: text(version.metadata?.operation) ?? undefined,
    },
    signedUrl: version.signedUrl,
  }));

  const assetHref = `/style/${styleId}/assets/${assetId}`;

  return (
    <div className="h-dvh overflow-hidden bg-background text-foreground">
      <header className="flex h-14 items-center gap-3 border-b border-border bg-muted px-4">
        <Link href={`/style/${styleId}`} className="max-w-32 truncate text-sm text-muted-foreground hover:text-foreground">{styleName}</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="min-w-0 flex-1 truncate font-semibold">{asset.name}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {selected?.signedUrl && (
            <Button asChild variant="outline" size="icon">
              <a href={selected.signedUrl} download aria-label="Download this version">
                <Download className="size-4" />
              </a>
            </Button>
          )}
          <Button asChild variant={candidate ? "outline" : "default"}>
            <Link href={`${assetHref}/edit`} aria-label="Edit this image">
              <Paintbrush className="size-4" />
              <span className="hidden sm:inline">Inpaint</span>
            </Link>
          </Button>
        </div>
      </header>

      <div className="flex h-[calc(100dvh-3.5rem)] flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
        <main className="min-w-0 flex-1 space-y-4 p-4 sm:p-6 xl:overflow-y-auto">
          {versionFallback && (
            <p role="status" className="flex items-start gap-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              That version is not part of this asset. Showing the current version instead.
            </p>
          )}

          {comparisonAvailable && selected && parent ? (
            <ComparisonSlider
              beforeUrl={parent.signedUrl as string}
              afterUrl={selected.signedUrl as string}
              beforeLabel="Original"
              afterLabel="Edited"
              width={selected.width || 800}
              height={selected.height || 600}
            />
          ) : selected?.signedUrl ? (
            <img src={selected.signedUrl} alt={asset.name} className="mx-auto max-h-[70vh] max-w-full rounded-lg object-contain" />
          ) : (
            <div className="flex h-64 items-center justify-center rounded-lg border border-border text-muted-foreground">Preview unavailable</div>
          )}

          {comparisonNotice && (
            <p className="flex items-start gap-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
              <GitCompare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              {comparisonNotice}
            </p>
          )}

          {reviewing && candidate && selected && (
            <Card aria-label="Review edit" className="space-y-3"><CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                <h2 className="font-semibold">Review edit</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                This edit is a candidate. Keeping it makes it the current version of {asset.name}; until then it stays in history only.
              </p>
              <VersionReviewActions assetId={assetId} assetHref={assetHref} versionId={selected.id} currentVersionId={asset.current_version_id ?? null} />
            </CardContent></Card>
          )}

          {reviewing && !candidate && selected && (
            <p role="status" className="flex items-start gap-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              You are viewing the current version. The unselected version remains in history.
            </p>
          )}
        </main>

        <aside className="w-full shrink-0 divide-y divide-border border-t border-border bg-muted xl:w-72 xl:overflow-y-auto xl:border-l xl:border-t-0">
          <div className="space-y-2 p-4">
            <h2 className="font-semibold">Asset info</h2>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p><span className="text-muted-foreground">Name:</span> {asset.name}</p>
              <p><span className="text-muted-foreground">Created:</span> {formatDateTime(asset.created_at)}</p>
              <p><span className="text-muted-foreground">Versions:</span> {versions.length}</p>
              {selected?.prompt && (
                <div>
                  <p className="text-muted-foreground">Prompt:</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs">{selected.prompt}</p>
                </div>
              )}
            </div>
          </div>

          {(provenance.length > 0 || sourceVersionId || adoptedCurrentStyle) && (
            <div className="space-y-2 p-4">
              <h2 className="font-semibold">Edit provenance</h2>
              <dl className="space-y-2 text-sm text-muted-foreground">
                {provenance.map((row) => (
                  <div key={row.label}>
                    <dt className="text-xs uppercase tracking-wide">{row.label}</dt>
                    <dd className="text-foreground">{row.value}</dd>
                  </div>
                ))}
                {sourceVersionId && (
                  <div>
                    <dt className="text-xs uppercase tracking-wide">Source version</dt>
                    <dd>
                      {sourceHref ? (
                        <Link href={sourceHref} className="text-primary hover:underline">
                          {sourceVersionId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-foreground">{sourceVersionId.slice(0, 8)}</span>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {adoptedCurrentStyle && (
                <p className="rounded-xl bg-warning/10 p-2 text-xs text-warning">
                  The original style of this source could not be recovered; this edit adopted the style that was current when it ran.
                </p>
              )}
            </div>
          )}

          <VersionHistory
            versions={historyVersions}
            currentVersionId={asset.current_version_id ?? null}
            assetId={assetId}
            assetHref={assetHref}
            selectedVersionId={selected?.id ?? null}
          />
        </aside>
      </div>
    </div>
  );
}
