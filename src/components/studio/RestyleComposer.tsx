"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
    <Card className="mt-6 gap-0 py-6">
      <CardContent className="space-y-5">
        <div>
          <Label htmlFor="restyle-style">Style</Label>
          {stylesLoading ? (
            <div className="mt-2" aria-hidden><Skeleton className="h-11 rounded-xl" /></div>
          ) : styles.length === 0 ? (
            <p className="mt-2 rounded-xl border border-dashed p-3 text-xs leading-5 text-muted-foreground">No active styles yet. Analyze and activate a style first.</p>
          ) : (
            <Select value={styleId ?? undefined} onValueChange={(next) => setStyleId(next || null)}>
              <SelectTrigger id="restyle-style" className="mt-2 w-full"><SelectValue placeholder="Select an active style" /></SelectTrigger>
              <SelectContent>
                {(() => {
                  const grouped = styles.filter((style) => style.libraryId);
                  const ungrouped = styles.filter((style) => !style.libraryId);
                  return <>
                    {grouped.map((style) => {
                      const library = libraries.find((lib) => lib.id === style.libraryId);
                      return <SelectItem key={style.id} value={style.id}>{library ? `${library.name} / ${style.name}` : style.name}</SelectItem>;
                    })}
                    {grouped.length > 0 && ungrouped.length > 0 && <SelectLabel>Ungrouped</SelectLabel>}
                    {ungrouped.map((style) => <SelectItem key={style.id} value={style.id}>{style.name}</SelectItem>)}
                  </>;
                })()}
              </SelectContent>
            </Select>
          )}
        </div>
        <div>
          <Label htmlFor="restyle-cost-mode">Cost mode</Label>
          <Select value={costMode} onValueChange={(next) => setCostMode(next as CostMode)}>
            <SelectTrigger id="restyle-cost-mode" className="mt-2 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{COST_MODE_OPTIONS.map((mode) => <SelectItem key={mode.id} value={mode.id}>{`${mode.label} — ${mode.description}`}</SelectItem>)}</SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">Style budget: {getStyleBudget(costMode)} chars</p>
        </div>
        <div>
          {selectedModel?.description && <p className="mt-2 text-xs leading-5 text-muted-foreground">{selectedModel.description}</p>}
          {selectedModel && <Label htmlFor="restyle-model-confirm" className="mt-2 gap-2 text-xs font-normal text-muted-foreground">
            <Checkbox id="restyle-model-confirm" checked={confirmedModelId === settings.modelId} onCheckedChange={(checked) => setConfirmedModelId(checked === true ? settings.modelId : null)} />
            Confirm effective model: {selectedModel.label}
          </Label>}
          {planPreview?.modelChanged && effectiveModelLabel && <p className="mt-1 text-xs text-warning">Plan resolves to {effectiveModelLabel}</p>}
        </div>
        <div>
          <Label htmlFor="restyle-source">Source image</Label>
          <Input id="restyle-source" type="file" accept="image/png,image/jpeg" className="mt-2" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (onSourceUpload) onSourceUpload(file);
          }} />
          {sourceUrl && <p className="mt-2 text-xs text-muted-foreground">Source ready. Preview updates on the canvas.</p>}
        </div>
        <div>
          <Label htmlFor="restyle-guidance">Prompt guidance (optional)</Label>
          <Textarea id="restyle-guidance" className="mt-2 resize-none" value={guidance} maxLength={8000} onChange={(event) => setGuidance(event.target.value)} placeholder="Optional direction for how strongly to apply the style" />
        </div>
        {error && <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
        <Button type="button" onClick={onSubmit} disabled={!canSubmit} className="w-full">
          {submitting ? <><LoaderCircle className="size-4 animate-spin" />Submitting restyle…</> : planPreview?.modelChanged ? `Use ${effectiveModelLabel} and generate` : "Submit restyle"}
        </Button>
      </CardContent>
    </Card>
  );
}
