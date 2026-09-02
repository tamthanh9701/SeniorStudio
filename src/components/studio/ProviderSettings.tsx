"use client";

import { Check, Eye, EyeOff, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

type ProviderRow = { provider: "openai" | "google"; label: string; hint: string; keyPlaceholder: string; configured: boolean; updatedAt?: string | null };

const INITIAL: ProviderRow[] = [
  { provider: "openai", label: "OpenAI", hint: "Enables GPT Image generation and masked inpaint.", keyPlaceholder: "sk-…", configured: false },
  { provider: "google", label: "Google AI Studio", hint: "Unlocks the dynamic Gemini image model catalog.", keyPlaceholder: "AIza…", configured: false },
];

export default function ProviderSettings() {
  const [rows, setRows] = useState(INITIAL);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<{ provider: string; kind: "saving" | "removing" } | null>(null);
  const [feedback, setFeedback] = useState<{ provider: string; kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/providers", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        if (!Array.isArray(body.providers)) return;
        setRows(INITIAL.map((row) => {
          const saved = body.providers.find((entry: { provider: string; updatedAt?: string }) => entry.provider === row.provider);
          return saved ? { ...row, configured: true, updatedAt: saved.updatedAt } : row;
        }));
      })
      .catch(() => setFeedback({ provider: "all", kind: "error", text: "Unable to load provider settings." }));
  }, []);

  const save = async (provider: "openai" | "google") => {
    setState({ provider, kind: "saving" });
    setFeedback(null);
    const response = await fetch("/api/settings/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey: drafts[provider] ?? "" }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, configured: true, updatedAt: new Date().toISOString() } : row));
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setFeedback({ provider, kind: "success", text: "API key saved." });
    } else {
      setFeedback({ provider, kind: "error", text: body.error?.message ?? "Unable to save API key." });
    }
    setState(null);
  };

  const remove = async (provider: "openai" | "google") => {
    setState({ provider, kind: "removing" });
    setFeedback(null);
    const response = await fetch(`/api/settings/providers?provider=${provider}`, { method: "DELETE" });
    if (response.ok) {
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, configured: false, updatedAt: null } : row));
      setFeedback({ provider, kind: "success", text: "API key removed." });
    } else {
      setFeedback({ provider, kind: "error", text: "Unable to remove API key." });
    }
    setState(null);
  };

  return <div className="space-y-4 p-5">
    <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-[#7c5cff]/12 text-[#a995ff]"><KeyRound className="size-5" /></span><div><h2 className="font-semibold">AI providers</h2><p className="text-sm text-[#98a2b3]">Keys are stored per workspace and never sent back to the browser.</p></div></div>
    {rows.map((row) => <section key={row.provider} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="font-medium">{row.label}</p><p className="mt-1 text-xs leading-5 text-[#98a2b3]">{row.hint}</p></div>
        <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${row.configured ? "bg-[#35c48d]/12 text-[#66d7ae]" : "bg-white/[0.06] text-[#667085]"}`}>{row.configured && <Check className="size-3" />}{row.configured ? "Connected" : "Not configured"}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input type={reveal[row.provider] ? "text" : "password"} value={drafts[row.provider] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [row.provider]: event.target.value }))} placeholder={row.configured ? "Replace stored key" : row.keyPlaceholder} aria-label={`${row.label} API key`} autoComplete="off" className="studio-control pr-10" />
          <button type="button" onClick={() => setReveal((current) => ({ ...current, [row.provider]: !current[row.provider] }))} aria-label={reveal[row.provider] ? "Hide API key" : "Show API key"} className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-[#667085] hover:text-white">{reveal[row.provider] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
        </div>
        <button onClick={() => save(row.provider)} disabled={!drafts[row.provider]?.trim() || state !== null} className="studio-button-primary shrink-0">{state?.provider === row.provider && state.kind === "saving" ? <LoaderCircle className="size-4 animate-spin" /> : "Save"}</button>
        {row.configured && <button onClick={() => remove(row.provider)} disabled={state !== null} className="studio-button-danger shrink-0">{state?.provider === row.provider && state.kind === "removing" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}</button>}
      </div>
      {row.configured && row.updatedAt && <p className="mt-2 text-xs text-[#667085]">Updated {new Date(row.updatedAt).toLocaleString()}</p>}
      {feedback?.provider === row.provider && <p role={feedback.kind === "error" ? "alert" : "status"} className={`mt-2 text-sm ${feedback.kind === "error" ? "text-[#ff9b9b]" : "text-[#66d7ae]"}`}>{feedback.text}</p>}
    </section>)}
  </div>;
}
