"use client";

import { Check, GitBranch, LoaderCircle } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

interface Version { id: string; source: string; prompt: string | null; created_at: string; parent_version_id: string | null; metadata?: { provider?: string; model?: string; operation?: string }; signedUrl?: string | null; }

export default function VersionHistory({ versions, currentVersionId, assetId, assetHref, selectedVersionId }: { versions: Version[]; currentVersionId: string | null; assetId: string; /** Base asset path; history links append `?version=` to it. */ assetHref: string; selectedVersionId?: string | null }) {
  const router = useRouter();
  const [changing, setChanging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const makeCurrent = async (versionId: string) => {
    setChanging(versionId);
    setError(null);
    const response = await fetch(`/api/assets/${assetId}/current`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // The observed current version makes this a compare-and-swap: a reviewer
      // who acted first wins and the others are told to reload.
      body: JSON.stringify({ versionId, expectedCurrentVersionId: currentVersionId ?? null }),
    });
    if (response.ok) {
      router.replace(`${assetHref}?version=${versionId}`);
      router.refresh();
    } else {
      const body = await response.json().catch(() => ({}));
      setError(body.error?.message ?? "Unable to make version current");
    }
    setChanging(null);
  };
  const depths = new Map<string, number>();
  for (const version of versions) depths.set(version.id, version.parent_version_id ? (depths.get(version.parent_version_id) ?? 0) + 1 : 0);
  return <section className="p-4"><div className="mb-4 flex items-center gap-2"><GitBranch className="size-4 text-primary" /><h2 className="font-semibold">Version history</h2></div>{error && <Alert variant="destructive" className="mb-3">{error}</Alert>}<div className="space-y-2">{versions.map((version) => { const current = version.id === currentVersionId; const selected = version.id === (selectedVersionId ?? currentVersionId); return <Card key={version.id} className={cn("gap-2 p-3", current ? "border-success/35 bg-success/5" : selected ? "border-primary bg-primary/10" : undefined)} style={{ marginLeft: Math.min((depths.get(version.id) ?? 0) * 12, 36) }}><Button variant="ghost" className="h-auto min-h-11 w-full items-start justify-start gap-3 whitespace-normal p-0 text-left" onClick={() => router.replace(`${assetHref}?version=${version.id}`)}><div className="size-11 shrink-0 overflow-hidden rounded-lg bg-stage">{version.signedUrl && <Image src={version.signedUrl} alt="" width={64} height={64} sizes="44px" className="h-full w-full object-cover" />}</div><span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-medium">{version.source}{current && <Badge variant="secondary" className="rounded-md bg-success/15 px-1.5 text-[10px] uppercase text-success">Current</Badge>}</span><span className="mt-1 block text-xs text-muted-foreground">{formatDateTime(version.created_at)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{[version.metadata?.provider, version.metadata?.model, version.metadata?.operation].filter(Boolean).join(" · ") || version.prompt || "Original version"}</span></span></Button>{!current && <Button variant="outline" size="sm" disabled={changing !== null} onClick={() => void makeCurrent(version.id)} className="mt-2 w-full text-xs">{changing === version.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}Make current</Button>}</Card>; })}</div></section>;
}
