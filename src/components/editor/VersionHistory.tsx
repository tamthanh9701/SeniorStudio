"use client";

import { Check, GitBranch, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Version { id: string; source: string; prompt: string | null; created_at: string; parent_version_id: string | null; metadata?: { provider?: string; model?: string; operation?: string }; signedUrl?: string | null; }

export default function VersionHistory({ versions, currentVersionId, projectId, assetId }: { versions: Version[]; currentVersionId: string | null; projectId: string; assetId: string }) {
  const router = useRouter();
  const [changing, setChanging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const makeCurrent = async (versionId: string) => { setChanging(versionId); setError(null); const response = await fetch(`/api/assets/${assetId}/current`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId }) }); if (response.ok) { router.replace(`/projects/${projectId}/assets/${assetId}?version=${versionId}`); router.refresh(); } else { const body = await response.json().catch(() => ({})); setError(body.error?.message ?? "Unable to make version current"); } setChanging(null); };
  const depths = new Map<string, number>();
  for (const version of versions) depths.set(version.id, version.parent_version_id ? (depths.get(version.parent_version_id) ?? 0) + 1 : 0);
  return <section className="p-4"><div className="mb-4 flex items-center gap-2"><GitBranch className="size-4 text-[#7c5cff]" /><h2 className="font-semibold">Version history</h2></div>{error && <p role="alert" className="mb-3 rounded-xl bg-[#ef6262]/10 p-3 text-sm text-[#ff9b9b]">{error}</p>}<div className="space-y-2">{versions.map((version) => { const current = version.id === currentVersionId; return <div key={version.id} className={`rounded-xl border p-3 ${current ? "border-[#35c48d]/35 bg-[#35c48d]/5" : "border-white/10 bg-white/[0.025]"}`} style={{ marginLeft: Math.min((depths.get(version.id) ?? 0) * 12, 36) }}><button className="flex min-h-11 w-full items-start gap-3 text-left" onClick={() => router.replace(`/projects/${projectId}/assets/${assetId}?version=${version.id}`)}><div className="size-11 shrink-0 overflow-hidden rounded-lg bg-black">{version.signedUrl && <img src={version.signedUrl} alt="" className="h-full w-full object-cover" />}</div><span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-medium">{version.source}{current && <span className="rounded-md bg-[#35c48d]/15 px-1.5 py-0.5 text-[10px] uppercase text-[#66d7ae]">Current</span>}</span><span className="mt-1 block text-xs text-[#667085]">{new Date(version.created_at).toLocaleString()}</span><span className="mt-1 block truncate text-xs text-[#98a2b3]">{[version.metadata?.provider, version.metadata?.model, version.metadata?.operation].filter(Boolean).join(" · ") || version.prompt || "Original version"}</span></span></button>{!current && <button disabled={changing !== null} onClick={() => makeCurrent(version.id)} className="studio-button-secondary mt-2 w-full min-h-9 py-1.5 text-xs">{changing === version.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}Make current</button>}</div>; })}</div></section>;
}
