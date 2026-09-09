"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";

interface SuggestedChange {
  group: string;
  field: string;
  current_value?: unknown;
  suggested_value: unknown;
  reason: string;
}

export default function TuningPanel({ styleId, generatedImageUrls }: { styleId: string; generatedImageUrls: string[] }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<{ drift_summary?: string; suggested_changes?: SuggestedChange[] } | null>(null);
  const [fidelity, setFidelity] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const analyze = async () => {
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/styles/${styleId}/tune`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generatedImageUrls, feedback: feedback || undefined }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setSuggestion(body.suggestion ?? null);
      setFidelity(body.fidelity ?? null);
      setSelected((body.suggestion?.suggested_changes ?? []).map((_change: SuggestedChange, index: number) => index));
    } else setMessage(`${body.error?.code ?? "STYLE_ANALYSIS_FAILED"}: ${body.error?.message ?? "Unable to analyze drift"}`);
    setBusy(false);
  };

  const apply = async () => {
    const changes = (suggestion?.suggested_changes ?? [])
      .filter((_change, index) => selected.includes(index))
      .map(change => ({
        group: change.group,
        field: change.field,
        suggested_value: change.suggested_value,
      }));
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/styles/${styleId}/tune/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
    const body = await response.json().catch(() => ({}));
    setMessage(response.ok ? "Selected changes applied." : `${body.error?.code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to apply changes"}`);
    setBusy(false);
  };

  return <details className="border-t border-white/10 p-4">
    <summary className="cursor-pointer text-sm font-medium">Evaluate &amp; Tune</summary>
    <div className="mt-3 space-y-3">
      <textarea className="studio-control min-h-20 w-full" placeholder="Optional feedback about style drift" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
      <button type="button" disabled={busy || generatedImageUrls.length === 0} className="studio-button-primary w-full" onClick={() => void analyze()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : null} Analyze drift</button>
      {suggestion?.drift_summary && <p className="text-xs text-[#98a2b3]">{suggestion.drift_summary}</p>}
      {suggestion?.suggested_changes?.map((change, index) => <label key={`${change.group}.${change.field}.${index}`} className="block rounded-lg border border-white/10 p-3 text-xs">
        <span className="flex gap-2"><input type="checkbox" checked={selected.includes(index)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, index] : current.filter((item) => item !== index))} /><strong>{change.group}.{change.field}</strong></span>
        <span className="mt-1 block text-[#667085]">{String(change.current_value ?? "—")} → {String(change.suggested_value)}</span>
        <span className="mt-1 block text-[#98a2b3]">{change.reason}</span>
      </label>)}
      {fidelity && <div className="grid grid-cols-2 gap-2 text-xs">{Object.entries(fidelity).filter(([, value]) => typeof value === "number").map(([key, value]) => <div key={key} className="rounded-lg bg-white/[0.04] p-2"><span className="block text-[#667085]">{key.replaceAll("_", " ")}</span><strong>{Math.round(Number(value) * 100)}%</strong></div>)}</div>}
      {suggestion?.suggested_changes?.length ? <button type="button" disabled={busy || selected.length === 0} className="studio-button-secondary w-full" onClick={() => void apply()}>Apply selected changes</button> : null}
      {message && <p role="status" className="text-xs text-[#98a2b3]">{message}</p>}
    </div>
  </details>;
}
