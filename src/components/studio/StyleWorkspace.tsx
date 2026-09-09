"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JobTimeline from "@/components/studio/JobTimeline";
import ModuleContextSidebar from "@/components/studio/ModuleContextSidebar";
import RestyleComposer from "@/components/studio/RestyleComposer";
import StyleCanvas from "@/components/studio/StyleCanvas";
import StudioShell from "@/components/studio/StudioShell";
import TuningPanel from "@/components/studio/TuningPanel";
import { AiJobSchema, isTerminalStatus, type ProjectJobFeedItem } from "@/db/ai-jobs";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { useModuleJobs } from "@/lib/ai/use-module-jobs";
import type { GenerationSettings } from "@/components/studio/GenerationComposer";
import type { CostMode } from "@/lib/style/cost-modes";

export default function StyleWorkspace({ projects, userEmail, models, initialJobs, activeStyles, libraries }: {
  projects: Array<{ id: string; name: string }>;
  userEmail: string;
  models: ModelCatalogEntry[];
  initialJobs: ProjectJobFeedItem[];
  activeStyles: Array<{ id: string; name: string; libraryId: string | null }>;
  libraries: Array<{ id: string; name: string }>;
}) {
  const [styleId, setStyleId] = useState<string | null>(activeStyles[0]?.id ?? null);
  const [sourceUrl, setSourceUrl] = useState("");
  const sourceObjectUrl = useRef<string | null>(null);
  const [sourceVersionId, setSourceVersionId] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [costMode, setCostMode] = useState<CostMode>("strict_1000");
  const [selectedOverride, setSelectedOverride] = useState<{ key: string; index: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availableModels = useMemo(() => models.filter((model) => model.operations.includes("image_to_image") || model.operations.includes("text_to_image")), [models]);
  const firstModel = availableModels[0];
  const [settings, setSettings] = useState<GenerationSettings>({ modelId: firstModel?.id ?? "", size: firstModel?.sizes[0] ?? "1024x1024", quality: firstModel?.qualities[0] ?? "auto", count: 1 });
  const [confirmedModelId, setConfirmedModelId] = useState<string | null>(null);
  useEffect(() => () => { if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current); }, []);
  const selectionKey = useMemo(() => JSON.stringify({ styleId, sourceVersionId, modelId: settings.modelId, size: settings.size, quality: settings.quality, count: settings.count, guidance }), [styleId, sourceVersionId, settings.modelId, settings.size, settings.quality, settings.count, guidance]);
  const selectedIndex = useMemo(() => (selectedOverride?.key === selectionKey ? selectedOverride.index : 0), [selectionKey, selectedOverride]);
  const setSelectedIndex = (index: number) => setSelectedOverride({ key: selectionKey, index });
  const { items, addJob } = useModuleJobs({ module: "style" }, initialJobs);
  const activeJobCount = items.filter(({ job }) => !isTerminalStatus(job.status)).length;
  const resultAssets = items.flatMap(({ job, result_urls }) => result_urls.map((url, index) => ({ id: `${job.id}-${index}`, name: (job.input.original_prompt ?? job.input.prompt).trim().slice(0, 80) || "Restyled", signedUrl: url, createdAt: job.created_at })));
  const selectResult = ({ url }: { url: string; assetId?: string }) => { const index = resultAssets.findIndex((asset) => asset.signedUrl === url); if (index >= 0) setSelectedIndex(index); };
  const selectedStyle = activeStyles.find((style) => style.id === styleId) ?? null;
  const handleSourceUpload = async (file: File) => {
    if (!styleId) return;
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    const nextUrl = URL.createObjectURL(file);
    sourceObjectUrl.current = nextUrl;
    setSourceUrl(nextUrl);
    setSourceVersionId(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/styles/${styleId}/sources`, { method: "POST", body: form });
      const body = await response.json();
      if (response.ok && body.versionId) setSourceVersionId(body.versionId);
      else setError(`${body.error?.code ?? "UPLOAD_FAILED"}: ${body.error?.message ?? "Source upload failed"}`);
    } catch { setError("UPLOAD_FAILED: Source upload failed"); }
  };

  const [executionPlan, setExecutionPlan] = useState<{ effectiveModelId: string; referenceCount: number; styleBudget: number; modelChanged: boolean } | null>(null);

  const submit = async () => {
    if (!styleId || !sourceVersionId || !settings.modelId || settings.modelId !== confirmedModelId) return;
    setSubmitting(true); setError(null);
    try {
      const planResponse = await fetch("/api/ai-execution-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "image_to_image",
          requestedModelId: settings.modelId,
          styleId,
          sourceVersionId,
          costMode,
          count: settings.count,
          size: settings.size,
          quality: settings.quality,
        }),
      });
      const planBody = await planResponse.json();
      if (!planResponse.ok) {
        setError(`${planBody.error?.code ?? "PLAN_FAILED"}: ${planBody.error?.message ?? "Failed to resolve execution plan"}`);
        setSubmitting(false);
        return;
      }

      const plan = planBody.plan;
      setExecutionPlan({
        effectiveModelId: plan.effectiveModelId,
        referenceCount: plan.referenceIds.length,
        styleBudget: plan.styleBudget,
        modelChanged: plan.modelChanged,
      });

      const consent = {
        effectiveModelId: plan.effectiveModelId,
        referenceIds: plan.referenceIds,
        styleBudget: plan.styleBudget,
        temperature: plan.temperature,
        modelChanged: plan.modelChanged,
      };

      const response = await fetch("/api/style/ai-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: settings.modelId,
          styleId,
          costMode,
          sourceVersionId,
          requestedModelId: settings.modelId,
          consent,
          count: settings.count,
          size: settings.size,
          quality: settings.quality,
          ...(guidance.trim() ? { prompt: guidance.trim() } : {}),
        }),
      });
      const body = await response.json();
      const parsed = AiJobSchema.safeParse(body.job);
      if (response.ok && parsed.success) {
        addJob(parsed.data);
        setGuidance("");
      } else {
        setError(`${body.error?.code ?? "INVALID_REQUEST"}: ${body.error?.message ?? "Restyle request failed"}`);
      }
    } catch {
      setError("NETWORK_ERROR: Failed to submit restyle request");
    }
    setSubmitting(false);
  };

  const cancel = async (job: ProjectJobFeedItem["job"]) => { const response = await fetch(`/api/ai-jobs/${job.id}/cancel`, { method: "POST" }); const body = await response.json(); const parsed = AiJobSchema.safeParse(body.job); if (response.ok && parsed.success) addJob(parsed.data); else setError(`${body.error?.code ?? "CANCEL_FAILED"}: ${body.error?.message ?? "Cancellation failed"}`); };
  const retry = (job: ProjectJobFeedItem["job"]) => {
    setGuidance(job.input.original_prompt ?? job.input.prompt);
    setStyleId(job.input.style_id ?? null);
    setSourceVersionId(job.input.source_version_id ?? null);
    setCostMode(job.input.cost_mode ?? "strict_1000");
    setSettings({ modelId: job.input.requested_model_id ?? job.model, size: job.input.size, quality: job.input.quality, count: job.input.count });
    setConfirmedModelId(null);
  };

  const inspector = <div className="min-h-full p-4 pt-16 xl:pt-4">
    <h1 className="font-semibold">Restyle</h1>
    <RestyleComposer models={availableModels} settings={settings} setSettings={(next) => { setSettings(next); setConfirmedModelId(null); }} styleId={styleId} setStyleId={setStyleId} costMode={costMode} setCostMode={setCostMode} sourceUrl={sourceUrl} guidance={guidance} setGuidance={setGuidance} submitting={submitting} error={error} onSubmit={submit} onSourceUpload={handleSourceUpload} confirmedModelId={confirmedModelId} setConfirmedModelId={setConfirmedModelId} planPreview={executionPlan ? { effectiveModelId: executionPlan.effectiveModelId, referenceCount: executionPlan.referenceCount, styleBudget: executionPlan.styleBudget, modelChanged: executionPlan.modelChanged } : undefined} />
  </div>;
  const sidebar = <ModuleContextSidebar currentModule="style" recentJobs={items} userEmail={userEmail} contextLabel={selectedStyle?.name ?? null} libraryTabs={libraries} />;
  const center = <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1 overflow-y-auto">
    <StyleCanvas results={resultAssets} selectedIndex={selectedIndex} onSelect={setSelectedIndex} previewUrl={sourceUrl || null} previewLabel={selectedStyle ? `Style: ${selectedStyle.name}` : null} loadingCount={activeJobCount} onEmptyFocus={() => undefined} />
    {styleId && resultAssets.length > 0 && <TuningPanel styleId={styleId} generatedImageUrls={resultAssets.slice(-4).map((asset) => asset.signedUrl)} />}
    {items.length > 0 && <div className="border-t border-white/10"><JobTimeline items={items} onRetry={retry} onCancel={cancel} onSelectResult={selectResult} /></div>}
  </div></div>;
  return <StudioShell projects={projects} userEmail={userEmail} recentJobs={items} leftSidebar={sidebar} center={center} inspector={inspector} />;
}