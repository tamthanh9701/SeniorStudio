"use client";

import { Focus, SwatchBook } from "lucide-react";
import { useEffect, useState } from "react";

export type StyleCanvasAsset = {
  id: string;
  name: string;
  signedUrl: string | null;
  createdAt: string;
};

export default function StyleCanvas({ results, selectedIndex, onSelect, previewUrl, previewLabel, loadingCount = 0, onEmptyFocus }: {
  results: StyleCanvasAsset[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  previewUrl: string | null;
  previewLabel: string | null;
  loadingCount?: number;
  onEmptyFocus: () => void;
}) {
  const selected = results[selectedIndex] ?? null;
  const [actualSize, setActualSize] = useState(false);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "ArrowLeft" && results.length) onSelect((selectedIndex - 1 + results.length) % results.length); if (event.key === "ArrowRight" && results.length) onSelect((selectedIndex + 1) % results.length); if (event.key === "Escape") setActualSize(false); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [results.length, onSelect, selectedIndex]);
  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
    <div className="checker-stage relative min-h-0 flex-1 overflow-auto p-4 sm:p-8">
      {selected?.signedUrl ? <div className="flex h-full min-h-[300px] items-center justify-center"><img src={selected.signedUrl} alt={selected.name} className={actualSize ? "max-w-none" : "max-h-full max-w-full object-contain"} /></div>
        : !selected && previewUrl ? <figure className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3"><img src={previewUrl} alt={previewLabel ?? "Style reference preview"} className="max-h-full max-w-[420px] rounded-2xl border border-white/10 object-contain" /><figcaption className="text-sm text-[#98a2b3]">{previewLabel ?? "Style reference preview"}</figcaption></figure>
        : !selected && loadingCount > 0 ? <div className="flex h-full min-h-[300px] items-center justify-center" aria-label="Generating restyled images"><span className="flex size-16 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]"><SwatchBook className="size-6 animate-pulse text-[#a995ff]" /></span></div>
        : !selected ? <button onClick={onEmptyFocus} className="flex h-full min-h-[340px] w-full flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 text-center"><span className="flex size-14 items-center justify-center rounded-2xl bg-[#7c5cff]/10 text-[#a995ff]"><SwatchBook className="size-7" /></span><h2 className="mt-5 text-xl font-semibold">Restyle with a saved style</h2><p className="mt-2 max-w-md px-5 text-sm leading-6 text-[#98a2b3]">Pick a style and a source image in the tool panel. Restyled results will appear here.</p></button> : null}
      {selected && <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/10 bg-[#111419]/90 p-1 shadow-xl backdrop-blur"><button className={`studio-icon-button size-9 min-h-9 ${!actualSize ? "bg-[#7c5cff]/25 text-white" : ""}`} onClick={() => setActualSize(false)} aria-label="Zoom to fit" aria-pressed={!actualSize} title="Zoom to fit"><Focus className="size-4" /></button><button className={`studio-icon-button size-9 min-h-9 ${actualSize ? "bg-[#7c5cff]/25 text-white" : ""}`} onClick={() => setActualSize(true)} aria-label="View at 100 percent" aria-pressed={actualSize} title="100%"><span className="text-[11px] font-semibold">100%</span></button></div>}
    </div>
    {results.length > 0 && <div className="shrink-0 overflow-x-auto border-t border-white/10 bg-[#111419] p-3"><div className="flex min-w-max gap-2">{results.map((result, index) => <button key={`${result.id}-${result.signedUrl}`} onClick={() => onSelect(index)} aria-label={`Select ${result.name}`} className={`min-h-0 overflow-hidden rounded-xl border-2 ${index === selectedIndex ? "border-[#7c5cff]" : "border-transparent"}`}>{result.signedUrl ? <img src={result.signedUrl} alt="" className="size-16 object-cover sm:size-20" /> : <span className="flex size-16 items-center justify-center bg-white/[0.04] text-xs text-[#667085] sm:size-20">Empty</span>}</button>)}</div></div>}
  </div>;
}
