"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";

interface SuggestedChange {
  id: string;
  group: string;
  field: string;
  current_value?: unknown;
  suggested_value: unknown;
  reason: string;
}

type TuningProposal = { id: string; drift_summary?: string; confidence?: string; changes: SuggestedChange[] };

export default function TuningPanel({ styleId, generatedVersionIds }: { styleId: string; generatedVersionIds: string[] }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<TuningProposal | null>(null);
  const [fidelity, setFidelity] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const analyze = async () => {
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/styles/${styleId}/tune`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generatedVersionIds, feedback: feedback || undefined }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const next = body.proposal as TuningProposal;
      setProposal(next);
      setFidelity(body.fidelity ?? null);
      setSelected([]);
    } else setMessage(`${body.error?.code ?? "STYLE_ANALYSIS_FAILED"}: ${body.error?.message ?? "Unable to analyze drift"}`);
    setBusy(false);
  };

  const apply = async () => {
    if (!proposal || selected.length === 0) return;
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/styles/${styleId}/proposals/${proposal.id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedChangeIds: selected }) });
    const body = await response.json().catch(() => ({}));
    setMessage(response.ok ? "Selected changes applied." : `${body.error?.code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to apply changes"}`);
    setBusy(false);
  };
  return <details className="border-t border-white/10 p-4">
    <summary className="cursor-pointer text-sm font-medium">Evaluate &amp; Tune</summary>
    <div className="mt-3 space-y-3">
      <textarea className="studio-control min-h-20 w-full" placeholder="Optional feedback about style drift" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
      <button type="button" disabled={busy || generatedVersionIds.length === 0} className="studio-button-primary w-full" onClick={() => void analyze()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : null} Analyze drift</button>
      {proposal?.drift_summary && <p className="text-xs text-[#98a2b3]">{proposal.drift_summary}</p>}
      {proposal?.changes.map((change) => <label key={change.id} className="block rounded-lg border border-white/10 p-3 text-xs">
        <span className="flex gap-2"><input type="checkbox" checked={selected.includes(change.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, change.id] : current.filter((id) => id !== change.id))} /><strong>{change.group}.{change.field}</strong></span>
        <span className="mt-1 block text-[#667085]">{String(change.current_value ?? "—")} → {String(change.suggested_value)}</span>
        <span className="mt-1 block text-[#98a2b3]">{change.reason}</span>
      </label>)}
      {fidelity && <div className="grid grid-cols-2 gap-2 text-xs">{Object.entries(fidelity).filter(([, value]) => typeof value === "number").map(([key, value]) => <div key={key} className="rounded-lg bg-white/[0.04] p-2"><span className="block text-[#667085]">{key.replaceAll("_", " ")}</span><strong>{Math.round(Number(value) * 100)}%</strong></div>)}</div>}
      {proposal?.changes.length ? <button type="button" disabled={busy || selected.length === 0} className="studio-button-secondary w-full" onClick={() => void apply()}>Apply selected changes</button> : null}
      {message && <p role="status" className="text-xs text-[#98a2b3]">{message}</p>}
    </div>
  </details>;
}

