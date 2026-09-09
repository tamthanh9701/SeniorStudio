"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { GenerationSettings } from "@/components/studio/GenerationComposer";
import { COST_MODE_OPTIONS, getStyleBudget, type CostMode } from "@/lib/style/cost-modes";

type StyleOption = { id: string; name: string; status: string; libraryId: string | null };

export default function RestyleComposer({ models, settings, setSettings, styleId, setStyleId, costMode, setCostMode, sourceUrl, guidance, setGuidance, submitting, error, onSubmit, onSourceUpload, confirmedModelId, setConfirmedModelId, planPreview }: {
  models: ModelCatalogEntry[];
  settings: GenerationSettings;
  setSettings: (settings: GenerationSettings) => void;
  styleId: string | null;
  setStyleId: (styleId: string | null) => void;
  costMode: CostMode;
  setCostMode: (mode: CostMode) => void;
  sourceUrl: string;
  guidance: string;
  setGuidance: (guidance: string) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
  onSourceUpload?: (file: File) => void;
  confirmedModelId: string | null;
  setConfirmedModelId: (modelId: string | null) => void;
  planPreview?: { effectiveModelId: string; referenceCount: number; styleBudget: number; modelChanged: boolean };
}) {
  const [styles, setStyles] = useState<StyleOption[]>([]);
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [stylesLoading, setStylesLoading] = useState(true);
  const selectedModel = models.find((model) => model.id === settings.modelId);

  useEffect(() => {
    fetch("/api/styles", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (Array.isArray(body.styles)) setStyles(body.styles.filter((style: StyleOption) => style.status === "active"));
    }).catch(() => undefined).finally(() => setStylesLoading(false));
    fetch("/api/styles/libraries", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (Array.isArray(body.libraries)) setLibraries(body.libraries);
    }).catch(() => undefined);
  }, []);

  const changeModel = (modelId: string) => {
    const model = models.find((entry) => entry.id === modelId);
    if (model) { setSettings({ modelId, size: model.sizes[0], quality: model.qualities[0], count: settings.count > model.maxCount ? 1 : settings.count }); setConfirmedModelId(null); }
  };

  const effectiveModelLabel = planPreview?.modelChanged
    ? models.find((m) => m.id === planPreview.effectiveModelId)?.label ?? planPreview.effectiveModelId
    : selectedModel?.label ?? null;

  const canSubmit = Boolean(styleId) && Boolean(sourceUrl.trim()) && Boolean(selectedModel) && Boolean(confirmedModelId === settings.modelId) && !submitting;

  return (
    <div className="mt-6 space-y-5">
      <div>
        <label className="studio-label" htmlFor="restyle-style">Style</label>
        {stylesLoading ? (
          <div className="mt-2 space-y-2" aria-hidden><div className="h-11 animate-pulse rounded-xl bg-white/[0.04]" /></div>
        ) : styles.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-white/15 p-3 text-xs leading-5 text-[#98a2b3]">No active styles yet. Analyze and activate a style first.</p>
        ) : (
          <select id="restyle-style" className="studio-control mt-2" value={styleId ?? ""} onChange={(event) => setStyleId(event.target.value || null)}>
            <option value="" disabled>Select an active style</option>
            {(() => {
              const grouped = styles.filter((style) => style.libraryId);
              const ungrouped = styles.filter((style) => !style.libraryId);
              return <>
                {grouped.map((style) => {
                  const library = libraries.find((lib) => lib.id === style.libraryId);
                  return <option key={style.id} value={style.id}>{library ? `${library.name} / ${style.name}` : style.name}</option>;
                })}
                {grouped.length > 0 && ungrouped.length > 0 && <optgroup label="Ungrouped" />}
                {ungrouped.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
              </>;
            })()}
          </select>
        )}
      </div>
      <div>
        <label className="studio-label" htmlFor="restyle-cost-mode">Cost mode</label>
        <select id="restyle-cost-mode" className="studio-control mt-2" value={costMode} onChange={(event) => setCostMode(event.target.value as CostMode)}>
          {COST_MODE_OPTIONS.map((mode) => <option key={mode.id} value={mode.id}>{mode.label} — {mode.description}</option>)}
        </select>
        <p className="mt-2 text-xs text-[#667085]">Style budget: {getStyleBudget(costMode)} chars</p>
      </div>
      <div>
        {selectedModel?.description && <p className="mt-2 text-xs leading-5 text-[#98a2b3]">{selectedModel.description}</p>}
        {selectedModel && <label className="mt-2 flex items-center gap-2 text-xs text-[#98a2b3]"><input type="checkbox" checked={confirmedModelId === settings.modelId} onChange={(event) => setConfirmedModelId(event.target.checked ? settings.modelId : null)} /> Confirm effective model: {selectedModel.label}</label>}
        {planPreview?.modelChanged && effectiveModelLabel && <p className="mt-1 text-xs text-[#f59e0b]">Plan resolves to {effectiveModelLabel}</p>}
      </div>
      <div>
        <label className="studio-label" htmlFor="restyle-source">Source image</label>
        <input id="restyle-source" type="file" accept="image/png,image/jpeg" className="studio-control" onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          if (onSourceUpload) onSourceUpload(file);
        }} />
        {sourceUrl && <p className="mt-2 text-xs text-[#667085]">Source ready. Preview updates on the canvas.</p>}
      </div>
      <div>
        <label className="studio-label" htmlFor="restyle-guidance">Prompt guidance (optional)</label>
        <textarea id="restyle-guidance" className="studio-control min-h-24 resize-none" value={guidance} maxLength={8000} onChange={(event) => setGuidance(event.target.value)} placeholder="Optional direction for how strongly to apply the style" />
      </div>
      {error && <p role="alert" className="text-xs text-[#ff9b9b]">{error}</p>}
      <button type="button" onClick={onSubmit} disabled={!canSubmit} className="studio-button-primary w-full">
        {submitting ? <><LoaderCircle className="size-4 animate-spin" />Submitting restyle…</> : planPreview?.modelChanged ? `Use ${effectiveModelLabel} and generate` : "Submit restyle"}
      </button>
    </div>
  );
}
