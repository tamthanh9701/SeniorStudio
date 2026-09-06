"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AssetCanvas from "@/components/studio/AssetCanvas";
import GenerationComposer, { type GenerationSettings } from "@/components/studio/GenerationComposer";
import JobTimeline from "@/components/studio/JobTimeline";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";
import ToolInspector, { type WorkspaceAsset } from "@/components/studio/ToolInspector";
import { AiJobSchema, isTerminalStatus, type ProjectJobFeedItem, type SupportedModelId } from "@/db/ai-jobs";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { useProjectJobs } from "@/lib/ai/use-project-jobs";

export default function ProjectWorkspace({ project, projects, userEmail, assets, models, initialJobs, styleProfilesEnabled }: { project: { id: string; name: string }; projects: Array<{ id: string; name: string }>; userEmail: string; assets: WorkspaceAsset[]; models: ModelCatalogEntry[]; initialJobs: ProjectJobFeedItem[]; styleProfilesEnabled: boolean }) {
  const router = useRouter();
  const availableModels = useMemo(() => models.filter((model) => model.operations.includes("text_to_image")), [models]);
  const firstModel = availableModels[0];
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState<GenerationSettings>({ modelId: firstModel?.id ?? "", size: firstModel?.sizes[0] ?? "1024x1024", quality: firstModel?.qualities[0] ?? "auto", count: 1 });
  const [tool, setTool] = useState<"generate" | "inpaint" | "style">("generate");
  const [styleId, setStyleId] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [styleHighlight, setStyleHighlight] = useState(false);
  const refreshed = useRef(new Set<string>());
  const { items, addJob } = useProjectJobs(project.id, initialJobs);
  const activeJobCount = items.filter(({ job }) => !isTerminalStatus(job.status)).length;
  const resultAssets = items.flatMap(({ job, result_urls }) => result_urls.map((url, index) => { const results = Array.isArray(job.output.results) ? job.output.results as Array<{ asset_id?: string; version_id?: string }> : []; return { id: results[index]?.asset_id ?? `${job.id}-${index}`, name: (job.input.original_prompt ?? job.input.prompt).trim().slice(0, 80) || "Untitled", signedUrl: url, versionId: results[index]?.version_id ?? null, createdAt: job.created_at }; }));
  const canvasAssets = [...assets, ...resultAssets.filter((result) => !assets.some((asset) => asset.id === result.id && asset.signedUrl === result.signedUrl))];
  const selectedAsset = canvasAssets[selectedIndex] ?? null;
  useEffect(() => { for (const { job } of items) if (job.status === "succeeded" && !refreshed.current.has(job.id)) { refreshed.current.add(job.id); router.refresh(); } }, [items, router]);
  const submit = async () => {
    const selectedModel = availableModels.find((model) => model.id === settings.modelId);
    if (!prompt.trim() || !selectedModel) return;
    setSubmitting(true); setError(null);
    const response = await fetch(`/api/projects/${project.id}/ai-jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "text_to_image", model: settings.modelId as SupportedModelId, prompt, count: settings.count, size: settings.size, quality: settings.quality, ...(styleId ? { styleId } : {}) }) });
    const body = await response.json();
    const parsed = AiJobSchema.safeParse(body.job);
    if (response.ok && parsed.success) { addJob(parsed.data); setPrompt(""); setFocusSignal((value) => value + 1); }
    else setError(`${body.error?.code ?? "INVALID_REQUEST"}: ${body.error?.message ?? "Generation request failed"}`);
    setSubmitting(false);
  };
  const cancel = async (job: ProjectJobFeedItem["job"]) => { const response = await fetch(`/api/ai-jobs/${job.id}/cancel`, { method: "POST" }); const body = await response.json(); const parsed = AiJobSchema.safeParse(body.job); if (response.ok && parsed.success) addJob(parsed.data); else setError(`${body.error?.code ?? "CANCEL_FAILED"}: ${body.error?.message ?? "Cancellation failed"}`); };
  const retry = (job: ProjectJobFeedItem["job"]) => { setPrompt(job.input.original_prompt ?? job.input.prompt); setStyleId(job.input.style_id ?? null); setSettings({ modelId: job.model, size: job.input.size, quality: job.input.quality, count: job.input.count }); setTool("generate"); setFocusSignal((value) => value + 1); setStyleHighlight(true); window.setTimeout(() => setStyleHighlight(false), 4000); };
  const selectResult = ({ url }: { url: string; assetId?: string }) => { const index = canvasAssets.findIndex((asset) => asset.signedUrl === url); if (index >= 0) setSelectedIndex(index); };
  const inspector = <ToolInspector tool={tool} setTool={setTool} models={availableModels} settings={settings} setSettings={setSettings} selectedAsset={selectedAsset} projectId={project.id} styleId={styleId} setStyleId={setStyleId} styleProfilesEnabled={styleProfilesEnabled} styleHighlight={styleHighlight} />;
  const sidebar = <ProjectSidebar projects={projects} activeProjectId={project.id} recentJobs={items} userEmail={userEmail} />;
  const center = <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1 overflow-y-auto"><AssetCanvas assets={canvasAssets} selectedIndex={selectedIndex} onSelect={setSelectedIndex} projectId={project.id} onEmptyFocus={() => setFocusSignal((value) => value + 1)} loadingCount={activeJobCount} />{items.length > 0 && <JobTimeline items={items} onRetry={retry} onCancel={cancel} onSelectResult={selectResult} />}</div><GenerationComposer prompt={prompt} setPrompt={setPrompt} settings={settings} selectedModel={availableModels.find((model) => model.id === settings.modelId)} submitting={submitting} error={error} onSubmit={submit} focusSignal={focusSignal} /></div>;
  return <StudioShell projects={projects} activeProjectId={project.id} userEmail={userEmail} recentJobs={items} leftSidebar={sidebar} center={center} inspector={inspector} />;
}
