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
  return <div className="border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--canvas)_95%,transparent)] px-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur xl:px-6 xl:pb-5">
    <div className="mx-auto max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-xl focus-within:border-[var(--accent)]">
      <textarea ref={ref} rows={1} value={prompt} maxLength={8000} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!disabled) onSubmit(); } }} placeholder={selectedModel ? "Describe the image you want to create" : "Select a model to begin"} aria-label="Generation prompt" className="max-h-40 min-h-12 w-full resize-none bg-transparent px-3 py-3 text-sm leading-6 text-[var(--text)] placeholder:text-[var(--placeholder)]" />
      <div className="flex items-center gap-2 px-1 pb-1"><button type="button" onClick={onOpenSettings} className="studio-button-secondary min-h-9 px-3 py-1.5 text-xs"><SlidersHorizontal className="size-3.5" />{selectedModel?.label ?? "Choose model"}</button><span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">{selectedModel ? `${settings.size} · ${settings.quality} · ${settings.count} image${settings.count > 1 ? "s" : ""}` : "Model selection required"}</span><button type="button" onClick={onSubmit} disabled={disabled} className="studio-button-primary min-h-9 px-3 py-1.5 text-xs"><ArrowUp className="size-3.5" />Generate</button></div>
    </div>
    {error && <p role="alert" className="mx-auto mt-2 max-w-3xl px-2 text-xs text-[var(--danger)]">{error}</p>}
  </div>;
}
