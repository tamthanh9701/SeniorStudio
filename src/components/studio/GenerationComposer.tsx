"use client";

import { ArrowUp, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { SupportedQuality, SupportedSize } from "@/db/ai-jobs";

export type GenerationSettings = { modelId: string; size: SupportedSize; quality: SupportedQuality; count: 1 | 2 | 3 | 4 };

export default function GenerationComposer({ prompt, setPrompt, settings, selectedModel, submitting, error, onSubmit, onOpenSettings, focusSignal = 0 }: {
  prompt: string;
  setPrompt: (value: string) => void;
  settings: GenerationSettings;
  selectedModel?: ModelCatalogEntry;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
  onOpenSettings?: () => void;
  focusSignal?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const textarea = ref.current; if (!textarea) return; textarea.style.height = "0px"; textarea.style.height = `${Math.min(160, textarea.scrollHeight)}px`; }, [prompt]);
  useEffect(() => { if (focusSignal > 0) ref.current?.focus(); }, [focusSignal]);
  const disabled = submitting || !prompt.trim() || !selectedModel;
  return <div className="border-t border-white/10 bg-[#0b0d10]/95 px-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur xl:px-6 xl:pb-5">
    <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-[#171b22] p-2 shadow-2xl shadow-black/35 focus-within:border-[#7c5cff]/60">
      <textarea ref={ref} rows={1} value={prompt} maxLength={8000} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!disabled) onSubmit(); } }} placeholder={selectedModel ? "Describe the image you want to create" : "Select a model to begin"} aria-label="Generation prompt" className="max-h-40 min-h-12 w-full resize-none bg-transparent px-3 py-3 text-sm leading-6 text-white placeholder:text-[#667085]" />
      <div className="flex items-center gap-2 px-1 pb-1"><button type="button" onClick={onOpenSettings} className="studio-button-secondary min-h-9 px-3 py-1.5 text-xs"><SlidersHorizontal className="size-3.5" />{selectedModel?.label ?? "Choose model"}</button><span className="min-w-0 flex-1 truncate text-xs text-[#667085]">{selectedModel ? `${settings.size} · ${settings.quality} · ${settings.count} image${settings.count > 1 ? "s" : ""}` : "Model selection required"}</span><button type="button" onClick={onSubmit} disabled={disabled} className="flex size-10 min-h-10 shrink-0 items-center justify-center rounded-xl bg-[#7c5cff] text-white transition hover:bg-[#6c4df0] disabled:opacity-35" aria-label="Generate image"><ArrowUp className="size-5" /></button></div>
    </div>
    {error && <p role="alert" className="mx-auto mt-2 max-w-3xl px-2 text-xs text-[#ff9b9b]">{error}</p>}
  </div>;
}
