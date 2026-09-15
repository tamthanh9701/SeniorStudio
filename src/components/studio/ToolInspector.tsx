"use client";

import Link from "next/link";
import { Paintbrush, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { SupportedQuality, SupportedSize } from "@/db/ai-jobs";
import type { GenerationSettings } from "@/components/studio/GenerationComposer";

export type WorkspaceAsset = { id: string; name: string; signedUrl: string | null; versionId: string | null; width?: number | null; height?: number | null; createdAt: string };

export default function ToolInspector({ tool, setTool, models, settings, setSettings, selectedAsset, projectId }: {
  tool: "generate" | "inpaint";
  setTool: (tool: "generate" | "inpaint") => void;
  models: ModelCatalogEntry[];
  settings: GenerationSettings;
  setSettings: (settings: GenerationSettings) => void;
  selectedAsset: WorkspaceAsset | null;
  projectId: string;
}) {
  const selected = models.find((model) => model.id === settings.modelId);
  const grouped = { google: models.filter((model) => model.provider === "google"), openai: models.filter((model) => model.provider === "openai") };
  const changeModel = (modelId: string) => { const model = models.find((entry) => entry.id === modelId); if (model) setSettings({ modelId, size: model.sizes[0], quality: model.qualities[0], count: settings.count > model.maxCount ? 1 : settings.count }); };
  return (
    <div className="min-h-full p-4 pt-16 xl:pt-4">
      <ToggleGroup type="single" value={tool} onValueChange={(value) => { if (value) setTool(value as "generate" | "inpaint"); }} aria-label="Tool" className="grid w-full grid-cols-2">
        <ToggleGroupItem value="generate" className="flex h-11 w-full items-center justify-center gap-2">
          <Sparkles className="size-4" />
          Generate
        </ToggleGroupItem>
        <ToggleGroupItem value="inpaint" className="flex h-11 w-full items-center justify-center gap-2">
          <Paintbrush className="size-4" />
          Inpaint
        </ToggleGroupItem>
      </ToggleGroup>

      {tool === "generate" ? (
        <div className="mt-6 space-y-5">
          <div className="min-w-0">
            <Label htmlFor="model" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Model</Label>
            <Select value={settings.modelId} onValueChange={changeModel}>
              <SelectTrigger id="model" className="w-full">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {grouped.google.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Google AI Studio</SelectLabel>
                    {grouped.google.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                  </SelectGroup>
                )}
                <SelectGroup>
                  <SelectLabel>OpenAI</SelectLabel>
                  {grouped.openai.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selected?.description && <p className="mt-2 text-xs leading-5 text-muted-foreground">{selected.description}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <Label htmlFor="size" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Size</Label>
              <Select value={settings.size} onValueChange={(value) => setSettings({ ...settings, size: value as SupportedSize })}>
                <SelectTrigger id="size" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selected?.sizes.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <Label htmlFor="quality" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Quality</Label>
              <Select value={settings.quality} onValueChange={(value) => setSettings({ ...settings, quality: value as SupportedQuality })}>
                <SelectTrigger id="quality" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selected?.qualities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="min-w-0">
            <Label htmlFor="count" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Count</Label>
            <Select value={String(settings.count)} onValueChange={(value) => setSettings({ ...settings, count: Number(value) as 1 | 2 | 3 | 4 })}>
              <SelectTrigger id="count" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].filter((value) => value <= (selected?.maxCount ?? 0)).map((value) => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border border-border bg-card p-3 text-xs leading-5 text-muted-foreground">
            Exact model ID: <span className="break-all text-foreground">{selected?.id ?? "No model selected"}</span>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <Label className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Selected asset</Label>
          {selectedAsset?.signedUrl ? (
            <Card className="gap-0 overflow-hidden p-0">
              <img src={selectedAsset.signedUrl} alt={selectedAsset.name} className="aspect-square w-full object-cover" />
              <CardContent className="p-3">
                <p className="truncate text-sm font-medium">{selectedAsset.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{selectedAsset.width && selectedAsset.height ? `${selectedAsset.width} × ${selectedAsset.height}` : "Current version"}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm leading-6 text-muted-foreground">Select an asset from the canvas or filmstrip to enable inpainting.</div>
          )}
          <Button asChild className="mt-4 w-full">
            <Link
              aria-disabled={!selectedAsset}
              tabIndex={selectedAsset ? 0 : -1}
              href={selectedAsset ? `/projects/${projectId}/assets/${selectedAsset.id}/edit` : "#"}
              className={cn(!selectedAsset && "pointer-events-none opacity-40")}
            >
              <Paintbrush className="size-4" />
              Open mask editor
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
