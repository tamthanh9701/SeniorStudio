"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { LoaderCircle, Paintbrush } from "lucide-react";
import MaskEditor from "@/components/editor/MaskEditor";
import StudioShell from "@/components/studio/StudioShell";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import { INPAINT_MODELS } from "@/lib/ai/models";
import { useAiJob } from "@/lib/ai/use-ai-job";
import { JOB_STATUS_LABELS } from "@/lib/ai/presentation";
import type { AiJob, SupportedModelId, SupportedQuality } from "@/db/ai-jobs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export default function EditAssetPage() {
  const params = useParams<{ projectId: string; assetId: string }>();
  const router = useRouter();
  const [asset, setAsset] = useState<{ id: string; name?: string } | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [email, setEmail] = useState("Signed in");
  const [version, setVersion] = useState<{ id: string; width: number; height: number } | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [maskPng, setMaskPng] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const models = INPAINT_MODELS.filter((model) => model.operations.includes("inpaint"));
  const [modelId, setModelId] = useState<SupportedModelId>(models[0].id);
  const selected = models.find((model) => model.id === modelId) ?? models[0];
  const [quality, setQuality] = useState<SupportedQuality>(selected.qualities[0]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, setJob } = useAiJob(null);
  useEffect(() => { Promise.all([fetch(`/api/assets/${params.assetId}`).then((response) => response.json()), fetch("/api/auth/workspace").then((response) => response.json())]).then(([data, workspace]) => { setAsset(data.asset); setVersion(data.version); setSignedUrl(data.signed_url); setProjects(workspace.projects ?? []); setEmail(workspace.user?.email ?? "Signed in"); }).catch(() => setError("Failed to load asset")).finally(() => setLoading(false)); }, [params.assetId]);
  useEffect(() => { if (job?.status === "succeeded" && job.version_id) router.push(`/projects/${params.projectId}/assets/${params.assetId}`); }, [job, params.assetId, params.projectId, router]);
  const submit = async () => { if (!maskPng || !version || !prompt.trim()) return; setSubmitting(true); setError(null); const maskResponse = await fetch(`/api/assets/${params.assetId}/masks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentVersionId: version.id, maskPng }) }); const maskBody = await maskResponse.json(); if (!maskResponse.ok) { setError(`${maskBody.error?.code}: ${maskBody.error?.message ?? "Mask upload failed"}`); setSubmitting(false); return; } const jobResponse = await fetch(`/api/assets/${params.assetId}/ai-jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "inpaint", model: modelId, parentVersionId: version.id, maskId: maskBody.maskId, prompt, quality }) }); const jobBody = await jobResponse.json(); if (jobResponse.ok) setJob(jobBody.job as AiJob); else setError(`${jobBody.error?.code}: ${jobBody.error?.message ?? "Inpaint enqueue failed"}`); setSubmitting(false); };
  if (loading) return <div className="flex min-h-dvh items-center justify-center"><LoaderCircle className="size-6 animate-spin text-primary" /></div>;
  if (!asset || !version || !signedUrl) return <div className="flex min-h-dvh items-center justify-center text-muted-foreground">Asset not found</div>;
  const sidebar = <ProjectSidebar activeModule="playground" userEmail={email} />;
  const inspector = <div className="p-4 pt-16 xl:pt-4"><div className="flex items-center gap-2"><Paintbrush className="size-4 text-primary" /><h1 className="font-semibold">Inpaint</h1></div><p className="mt-2 text-xs leading-5 text-muted-foreground">Transparent mask regions are edited against the exact current parent version.</p><div className="mt-6 space-y-4"><div className="space-y-2"><Label className="text-xs font-semibold">Model</Label><Select value={modelId} onValueChange={(value) => { const nextModel = models.find((model) => model.id === value); if (!nextModel) return; setModelId(nextModel.id); setQuality(nextModel.qualities[0]); }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label className="text-xs font-semibold">Quality</Label><Select value={quality} onValueChange={(value) => setQuality(value as SupportedQuality)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{selected.qualities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label className="text-xs font-semibold">Prompt</Label><Textarea className="min-h-32 resize-none" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the requested edit" /></div>{job && <div className="rounded-xl border border-white/10 bg-white/[0.025] p-3 text-sm text-muted-foreground">{JOB_STATUS_LABELS[job.status]}</div>}{error && <p className="text-sm text-destructive">{error}</p>}</div></div>;
  const center = <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1"><MaskEditor imageUrl={signedUrl} width={version.width} height={version.height} onMaskChange={setMaskPng} /></div><div className="border-t border-border bg-muted p-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))] xl:pb-3"><Button onClick={submit} className="w-full" disabled={!maskPng || !prompt.trim() || submitting || Boolean(job && !["failed", "canceled"].includes(job.status))}>{submitting ? <><LoaderCircle className="size-4 animate-spin" />Enqueuing…</> : "Apply inpaint"}</Button></div></div>;
  return <StudioShell projects={projects} activeProjectId={params.projectId} userEmail={email} leftSidebar={sidebar} center={center} inspector={inspector} />;
}
