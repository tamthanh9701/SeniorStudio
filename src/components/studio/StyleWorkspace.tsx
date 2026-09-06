"use client";

import { useMemo, useState } from "react";
import JobTimeline from "@/components/studio/JobTimeline";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import RestyleComposer from "@/components/studio/RestyleComposer";
import StyleCanvas from "@/components/studio/StyleCanvas";
import StudioShell from "@/components/studio/StudioShell";
import { AiJobSchema, isTerminalStatus, type ProjectJobFeedItem } from "@/db/ai-jobs";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { useModuleJobs } from "@/lib/ai/use-module-jobs";
import type { GenerationSettings } from "@/components/studio/GenerationComposer";

export default function StyleWorkspace({ projects, userEmail, models, initialJobs, activeStyles }: {
  projects: Array<{ id: string; name: string }>;
  userEmail: string;
  models: ModelCatalogEntry[];
  initialJobs: ProjectJobFeedItem[];
  activeStyles: Array<{ id: string; name: string }>;
}) {
  const [styleId, setStyleId] = useState<string | null>(activeStyles[0]?.id ?? null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [guidance, setGuidance] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availableModels = useMemo(() => models.filter((model) => model.operations.includes("text_to_image")), [models]);
  const firstModel = availableModels[0];
  const [settings, setSettings] = useState<GenerationSettings>({ modelId: firstModel?.id ?? "", size: firstModel?.sizes[0] ?? "1024x1024", quality: firstModel?.qualities[0] ?? "auto", count: 1 });
  const { items, addJob } = useModuleJobs({ module: "style" }, initialJobs);
  const activeJobCount = items.filter(({ job }) => !isTerminalStatus(job.status)).length;
  const resultAssets = items.flatMap(({ job, result_urls }) => result_urls.map((url, index) => ({ id: `${job.id}-${index}`, name: (job.input.original_prompt ?? job.input.prompt).trim().slice(0, 80) || "Restyled", signedUrl: url, createdAt: job.created_at })));
  const selectResult = ({ url }: { url: string; assetId?: string }) => { const index = resultAssets.findIndex((asset) => asset.signedUrl === url); if (index >= 0) setSelectedIndex(index); };
  const selectedStyle = activeStyles.find((style) => style.id === styleId) ?? null;

  const submit = async () => {
    if (!styleId || !sourceUrl.trim() || !settings.modelId) return;
    setSubmitting(true); setError(null);
    const response = await fetch("/api/style/ai-jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: settings.modelId, styleId, sourceUrl: sourceUrl.trim(), count: settings.count, size: settings.size, quality: settings.quality, ...(guidance.trim() ? { prompt: guidance.trim() } : {}) }) });
    const body = await response.json();
    const parsed = AiJobSchema.safeParse(body.job);
    if (response.ok && parsed.success) { addJob(parsed.data); setGuidance(""); }
    else setError(`${body.error?.code ?? "INVALID_REQUEST"}: ${body.error?.message ?? "Restyle request failed"}`);
    setSubmitting(false);
  };
  const cancel = async (job: ProjectJobFeedItem["job"]) => { const response = await fetch(`/api/ai-jobs/${job.id}/cancel`, { method: "POST" }); const body = await response.json(); const parsed = AiJobSchema.safeParse(body.job); if (response.ok && parsed.success) addJob(parsed.data); else setError(`${body.error?.code ?? "CANCEL_FAILED"}: ${body.error?.message ?? "Cancellation failed"}`); };
  const retry = (job: ProjectJobFeedItem["job"]) => { setGuidance(job.input.original_prompt ?? job.input.prompt); setStyleId(job.input.style_id ?? null); setSettings({ modelId: job.model, size: job.input.size, quality: job.input.quality, count: job.input.count }); };

  const inspector = (
    <div className="min-h-full p-4 pt-16 xl:pt-4">
      <h1 className="font-semibold">Restyle</h1>
      <RestyleComposer
        models={availableModels}
        settings={settings}
        setSettings={setSettings}
        styleId={styleId}
        setStyleId={setStyleId}
        sourceUrl={sourceUrl}
        setSourceUrl={setSourceUrl}
        guidance={guidance}
        setGuidance={setGuidance}
        submitting={submitting}
        error={error}
        onSubmit={submit}
      />
    </div>
  );
  const sidebar = <ModuleContextSidebar currentModule="style" recentJobs={items} userEmail={userEmail} contextLabel={selectedStyle?.name ?? null} />;
  const center = <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto">
      <StyleCanvas results={resultAssets} selectedIndex={selectedIndex} onSelect={setSelectedIndex} previewUrl={sourceUrl || null} previewLabel={selectedStyle ? `Style: ${selectedStyle.name}` : null} loadingCount={activeJobCount} onEmptyFocus={() => undefined} />
      {items.length > 0 && <div className="border-t border-white/10"><JobTimeline items={items} onRetry={retry} onCancel={cancel} onSelectResult={selectResult} /></div>}
    </div>
  </div>;
  return <StudioShell projects={projects} userEmail={userEmail} recentJobs={items} leftSidebar={sidebar} center={center} inspector={inspector} />;
}
