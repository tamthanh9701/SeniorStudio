"use client";

import Link from "next/link";
import { Paintbrush, Sparkles } from "lucide-react";
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
  return <div className="min-h-full p-4 pt-16 xl:pt-4">
    <div className="grid grid-cols-2 rounded-xl bg-white/[0.045] p-1"><button onClick={() => setTool("generate")} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium ${tool === "generate" ? "bg-[#171b22] text-white shadow" : "text-[#98a2b3]"}`}><Sparkles className="size-4" />Generate</button><button onClick={() => setTool("inpaint")} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium ${tool === "inpaint" ? "bg-[#171b22] text-white shadow" : "text-[#98a2b3]"}`}><Paintbrush className="size-4" />Inpaint</button></div>
    {tool === "generate" ? <div className="mt-6 space-y-5"><div><label className="studio-label" htmlFor="model">Model</label><select id="model" className="studio-control" value={settings.modelId} onChange={(event) => changeModel(event.target.value)}><option value="" disabled>Select a model</option>{grouped.google.length > 0 && <optgroup label="Google AI Studio">{grouped.google.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</optgroup>}<optgroup label="OpenAI">{grouped.openai.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</optgroup></select>{selected?.description && <p className="mt-2 text-xs leading-5 text-[#98a2b3]">{selected.description}</p>}</div><div className="grid grid-cols-2 gap-3"><label><span className="studio-label">Size</span><select className="studio-control" value={settings.size} onChange={(event) => setSettings({ ...settings, size: event.target.value as SupportedSize })}>{selected?.sizes.map((value) => <option key={value}>{value}</option>)}</select></label><label><span className="studio-label">Quality</span><select className="studio-control" value={settings.quality} onChange={(event) => setSettings({ ...settings, quality: event.target.value as SupportedQuality })}>{selected?.qualities.map((value) => <option key={value}>{value}</option>)}</select></label></div><label><span className="studio-label">Count</span><select className="studio-control" value={settings.count} onChange={(event) => setSettings({ ...settings, count: Number(event.target.value) as 1 | 2 | 3 | 4 })}>{[1,2,3,4].filter((value) => value <= (selected?.maxCount ?? 0)).map((value) => <option key={value}>{value}</option>)}</select></label><div className="rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-[#98a2b3]">Exact model ID: <span className="break-all text-[#d0d5dd]">{selected?.id ?? "No model selected"}</span></div></div> : <div className="mt-6"><p className="studio-label">Selected asset</p>{selectedAsset?.signedUrl ? <div className="overflow-hidden rounded-xl border border-white/10"><img src={selectedAsset.signedUrl} alt={selectedAsset.name} className="aspect-square w-full object-cover" /><div className="p-3"><p className="truncate text-sm font-medium">{selectedAsset.name}</p><p className="mt-1 text-xs text-[#667085]">{selectedAsset.width && selectedAsset.height ? `${selectedAsset.width} × ${selectedAsset.height}` : "Current version"}</p></div></div> : <div className="rounded-xl border border-dashed border-white/15 p-5 text-center text-sm leading-6 text-[#98a2b3]">Select an asset from the canvas or filmstrip to enable inpainting.</div>}<Link aria-disabled={!selectedAsset} tabIndex={selectedAsset ? 0 : -1} href={selectedAsset ? `/projects/${projectId}/assets/${selectedAsset.id}/edit` : "#"} className={`studio-button-primary mt-4 w-full ${!selectedAsset ? "pointer-events-none opacity-40" : ""}`}><Paintbrush className="size-4" />Open mask editor</Link></div>}
  </div>;
}
