"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { GenerationSettings } from "@/components/studio/GenerationComposer";

type StyleOption = { id: string; name: string; status: string };

export default function RestyleComposer({ models, settings, setSettings, styleId, setStyleId, sourceUrl, setSourceUrl, guidance, setGuidance, submitting, error, onSubmit }: {
  models: ModelCatalogEntry[];
  settings: GenerationSettings;
  setSettings: (settings: GenerationSettings) => void;
  styleId: string | null;
  setStyleId: (styleId: string | null) => void;
  sourceUrl: string;
  setSourceUrl: (url: string) => void;
  guidance: string;
  setGuidance: (guidance: string) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  const [styles, setStyles] = useState<StyleOption[]>([]);
  const [stylesLoading, setStylesLoading] = useState(true);
  const selectedModel = models.find((model) => model.id === settings.modelId);

  useEffect(() => {
    fetch("/api/styles", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (Array.isArray(body.styles)) setStyles(body.styles.filter((style: StyleOption) => style.status === "active"));
    }).catch(() => undefined).finally(() => setStylesLoading(false));
  }, []);

  const changeModel = (modelId: string) => {
    const model = models.find((entry) => entry.id === modelId);
    if (model) setSettings({ modelId, size: model.sizes[0], quality: model.qualities[0], count: settings.count > model.maxCount ? 1 : settings.count });
  };

  const canSubmit = useMemo(() => Boolean(styleId) && Boolean(sourceUrl.trim()) && Boolean(selectedModel) && !submitting, [styleId, sourceUrl, selectedModel, submitting]);

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
            {styles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
          </select>
        )}
      </div>
      <div>
        <label className="studio-label" htmlFor="restyle-model">Model</label>
        <select id="restyle-model" className="studio-control" value={settings.modelId} onChange={(event) => changeModel(event.target.value)}>
          <option value="" disabled>Select a model</option>
          {models.filter((model) => model.operations.includes("text_to_image")).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
        {selectedModel?.description && <p className="mt-2 text-xs leading-5 text-[#98a2b3]">{selectedModel.description}</p>}
      </div>
      <div>
        <label className="studio-label" htmlFor="restyle-source">Source image</label>
        <input id="restyle-source" type="file" accept="image/png,image/jpeg" className="studio-control" onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setSourceUrl(URL.createObjectURL(file));
        }} />
        {sourceUrl && <p className="mt-2 text-xs text-[#667085]">Source ready. Preview updates on the canvas.</p>}
      </div>
      <div>
        <label className="studio-label" htmlFor="restyle-guidance">Prompt guidance (optional)</label>
        <textarea id="restyle-guidance" className="studio-control min-h-24 resize-none" value={guidance} maxLength={8000} onChange={(event) => setGuidance(event.target.value)} placeholder="Optional direction for how strongly to apply the style" />
      </div>
      {error && <p role="alert" className="text-xs text-[#ff9b9b]">{error}</p>}
      <button type="button" onClick={onSubmit} disabled={!canSubmit} className="studio-button-primary w-full">
        {submitting ? <><LoaderCircle className="size-4 animate-spin" />Submitting restyle…</> : "Submit restyle"}
      </button>
    </div>
  );
}
