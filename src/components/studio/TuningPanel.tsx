"use client";

import { useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const analyze = async () => {
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/styles/${styleId}/tune`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generatedVersionIds, feedback: feedback || undefined }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const next = body.proposal as TuningProposal;
      setProposal(next);
      setFidelity(body.fidelity ?? null);
      setSelected([]);
    } else setMessage({ kind: "error", text: `${body.error?.code ?? "STYLE_ANALYSIS_FAILED"}: ${body.error?.message ?? "Unable to analyze drift"}` });
    setBusy(false);
  };

  const apply = async () => {
    if (!proposal || selected.length === 0) return;
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/styles/${styleId}/proposals/${proposal.id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedChangeIds: selected }) });
    const body = await response.json().catch(() => ({}));
    setMessage(response.ok
      ? { kind: "success", text: "Selected changes applied." }
      : { kind: "error", text: `${body.error?.code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to apply changes"}` });
    setBusy(false);
  };
  return <Card className="py-4">
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group mx-4 h-auto justify-between gap-3 py-2 whitespace-normal">
          <span className="text-sm font-medium">Evaluate &amp; Tune</span>
          <ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-4 mt-3 space-y-3">
          <Textarea placeholder="Optional feedback about style drift" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
          <Button type="button" disabled={busy || generatedVersionIds.length === 0} className="w-full" onClick={() => void analyze()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : null} Analyze drift</Button>
          {proposal?.drift_summary && <p className="text-xs text-muted-foreground">{proposal.drift_summary}</p>}
          {proposal?.changes.map((change, index) => <Label key={change.id} htmlFor={`tune-change-${index}`} className="block rounded-lg border p-3 text-xs leading-normal font-normal">
            <span className="flex gap-2">
              <Checkbox id={`tune-change-${index}`} checked={selected.includes(change.id)} onCheckedChange={(checked) => setSelected((current) => checked === true ? [...current, change.id] : current.filter((id) => id !== change.id))} />
              <strong>{change.group}.{change.field}</strong>
            </span>
            <span className="mt-1 block text-muted-foreground">{String(change.current_value ?? "—")} → {String(change.suggested_value)}</span>
            <span className="mt-1 block text-muted-foreground">{change.reason}</span>
          </Label>)}
          {fidelity && <div className="grid grid-cols-2 gap-2 text-xs">{Object.entries(fidelity).filter(([, value]) => typeof value === "number").map(([key, value]) => <div key={key} className="rounded-lg bg-muted p-2"><span className="block text-muted-foreground">{key.replaceAll("_", " ")}</span><strong>{Math.round(Number(value) * 100)}%</strong></div>)}</div>}
          {proposal?.changes.length ? <Button type="button" variant="outline" disabled={busy || selected.length === 0} className="w-full" onClick={() => void apply()}>Apply selected changes</Button> : null}
          {message && <Alert role="status" variant={message.kind === "error" ? "destructive" : "default"}><AlertDescription className="text-xs">{message.text}</AlertDescription></Alert>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  </Card>;
}
