"use client";

import Link from "next/link";
import { Paintbrush, Sparkles, SwatchBook } from "lucide-react";
import StylePanel from "@/components/studio/StylePanel";
import { useEffect, useState } from "react";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { SupportedQuality, SupportedSize } from "@/db/ai-jobs";
import type { GenerationSettings } from "@/components/studio/GenerationComposer";

export type WorkspaceAsset = { id: string; name: string; signedUrl: string | null; versionId: string | null; width?: number | null; height?: number | null; createdAt: string };

type StyleOption = { id: string; name: string; status: string };

export default function ToolInspector({ tool, setTool, models, settings, setSettings, selectedAsset, projectId, styleId, setStyleId, styleProfilesEnabled, styleHighlight = false }: {
  tool: "generate" | "inpaint" | "style";
  setTool: (tool: "generate" | "inpaint" | "style") => void;
  models: ModelCatalogEntry[];
  settings: GenerationSettings;
  setSettings: (settings: GenerationSettings) => void;
  selectedAsset: WorkspaceAsset | null;
  projectId: string;
  styleId: string | null;
  setStyleId: (styleId: string | null) => void;
  styleProfilesEnabled: boolean;
  styleHighlight?: boolean;
}) {
  const selected = models.find((model) => model.id === settings.modelId);
  const grouped = { google: models.filter((model) => model.provider === "google"), openai: models.filter((model) => model.provider === "openai") };
  const changeModel = (modelId: string) => { const model = models.find((entry) => entry.id === modelId); if (model) setSettings({ modelId, size: model.sizes[0], quality: model.qualities[0], count: settings.count > model.maxCount ? 1 : settings.count }); };
  const [activeStyles, setActiveStyles] = useState<StyleOption[]>([]);
  useEffect(() => {
    if (!styleProfilesEnabled) return;
    fetch("/api/styles", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (Array.isArray(body.styles)) setActiveStyles(body.styles.filter((style: StyleOption) => style.status === "active"));
    }).catch(() => undefined);
  }, [styleProfilesEnabled, tool]);
  const styleTab = styleProfilesEnabled ? <button onClick={() => setTool("style")} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium ${tool === "style" ? "bg-[#171b22] text-white shadow" : "text-[#98a2b3]"}`}><SwatchBook className="size-4" />Style</button> : null;
  return <div className="min-h-full p-4 pt-16 xl:pt-4">
    <div className={`grid rounded-xl bg-white/[0.045] p-1 ${styleTab ? "grid-cols-3" : "grid-cols-2"}`}><button onClick={() => setTool("generate")} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium ${tool === "generate" ? "bg-[#171b22] text-white shadow" : "text-[#98a2b3]"}`}><Sparkles className="size-4" />Generate</button><button onClick={() => setTool("inpaint")} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium ${tool === "inpaint" ? "bg-[#171b22] text-white shadow" : "text-[#98a2b3]"}`}><Paintbrush className="size-4" />Inpaint</button>{styleTab}</div>
    {tool === "generate" ? <div className="mt-6 space-y-5"><div><label className="studio-label" htmlFor="model">Model</label><select id="model" className="studio-control" value={settings.modelId} onChange={(event) => changeModel(event.target.value)}><option value="" disabled>Select a model</option>{grouped.google.length > 0 && <optgroup label="Google AI Studio">{grouped.google.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</optgroup>}<optgroup label="OpenAI">{grouped.openai.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</optgroup></select>{selected?.description && <p className="mt-2 text-xs leading-5 text-[#98a2b3]">{selected.description}</p>}</div>{styleProfilesEnabled && <div><label className="studio-label" htmlFor="style-selector">Style</label><select id="style-selector" className={`studio-control ${styleHighlight ? "ring-2 ring-[#7c5cff]" : ""}`} value={styleId ?? ""} onChange={(event) => setStyleId(event.target.value || null)}><option value="">None</option>{activeStyles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}</select><p className="mt-2 text-xs leading-5 text-[#98a2b3]">Active styles steer the look of every generation; subject comes from your prompt.</p></div>}<div className="grid grid-cols-2 gap-3"><label><span className="studio-label">Size</span><select className="studio-control" value={settings.size} onChange={(event) => setSettings({ ...settings, size: event.target.value as SupportedSize })}>{selected?.sizes.map((value) => <option key={value}>{value}</option>)}</select></label><label><span className="studio-label">Quality</span><select className="studio-control" value={settings.quality} onChange={(event) => setSettings({ ...settings, quality: event.target.value as SupportedQuality })}>{selected?.qualities.map((value) => <option key={value}>{value}</option>)}</select></label></div><label><span className="studio-label">Count</span><select className="studio-control" value={settings.count} onChange={(event) => setSettings({ ...settings, count: Number(event.target.value) as 1 | 2 | 3 | 4 })}>{[1,2,3,4].filter((value) => value <= (selected?.maxCount ?? 0)).map((value) => <option key={value}>{value}</option>)}</select></label><div className="rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-[#98a2b3]">Exact model ID: <span className="break-all text-[#d0d5dd]">{selected?.id ?? "No model selected"}</span></div></div> : tool === "style" && styleProfilesEnabled ? <div className="mt-6"><StylePanel /></div> : <div className="mt-6"><p className="studio-label">Selected asset</p>{selectedAsset?.signedUrl ? <div className="overflow-hidden rounded-xl border border-white/10"><img src={selectedAsset.signedUrl} alt={selectedAsset.name} className="aspect-square w-full object-cover" /><div className="p-3"><p className="truncate text-sm font-medium">{selectedAsset.name}</p><p className="mt-1 text-xs text-[#667085]">{selectedAsset.width && selectedAsset.height ? `${selectedAsset.width} × ${selectedAsset.height}` : "Current version"}</p></div></div> : <div className="rounded-xl border border-dashed border-white/15 p-5 text-center text-sm leading-6 text-[#98a2b3]">Select an asset from the canvas or filmstrip to enable inpainting.</div>}<Link aria-disabled={!selectedAsset} tabIndex={selectedAsset ? 0 : -1} href={selectedAsset ? `/projects/${projectId}/assets/${selectedAsset.id}/edit` : "#"} className={`studio-button-primary mt-4 w-full ${!selectedAsset ? "pointer-events-none opacity-40" : ""}`}><Paintbrush className="size-4" />Open mask editor</Link></div>}
  </div>;
}
