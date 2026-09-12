"use client";

import { Check, Eye, EyeOff, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type ProviderRow = { provider: "openai" | "google"; label: string; hint: string; keyPlaceholder: string; configured: boolean; availability: "unknown" | "available" | "unavailable"; validation: "not_run" | "passed" | "failed"; updatedAt?: string | null };

const INITIAL: ProviderRow[] = [
  { provider: "openai", label: "OpenAI", hint: "Enables GPT Image generation and masked inpaint.", keyPlaceholder: "sk-…", configured: false, availability: "unknown", validation: "not_run" },
  { provider: "google", label: "Google AI Studio", hint: "Unlocks the dynamic Gemini image model catalog.", keyPlaceholder: "AIza…", configured: false, availability: "unknown", validation: "not_run" },
];

export default function ProviderSettings() {
  const [rows, setRows] = useState(INITIAL);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<{ provider: string; kind: "saving" | "removing" } | null>(null);
  const [feedback, setFeedback] = useState<{ provider: string; kind: "success" | "error"; text: string } | null>(null);
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);

  const load = useCallback(async () => {
    setLoadStatus("loading");
    setFeedback((current) => (current?.provider === "all" ? null : current));
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch("/api/settings/providers", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Unable to load provider settings (${response.status})`);
      const body = await response.json();
      if (!Array.isArray(body.providers)) throw new Error("Malformed provider settings response");
      if (!mountedRef.current) return;
      setRows(INITIAL.map((row) => {
        const saved = body.providers.find((entry: { provider: string; updatedAt?: string }) => entry.provider === row.provider);
        return saved ? { ...row, configured: true, availability: "unknown", validation: "not_run", updatedAt: saved.updatedAt } : row;
      }));
      setLoadStatus("ready");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (!mountedRef.current) return;
      setLoadStatus("error");
      setFeedback({ provider: "all", kind: "error", text: "Unable to load provider settings." });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (provider: "openai" | "google") => {
    setState({ provider, kind: "saving" }); setFeedback(null);
    try {
      const response = await fetch("/api/settings/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey: drafts[provider] ?? "" }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to save API key.");
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, configured: true, availability: "unknown", validation: "not_run", updatedAt: new Date().toISOString() } : row));
      setDrafts((current) => ({ ...current, [provider]: "" })); setFeedback({ provider, kind: "success", text: "API key saved. Provider validation has not run." });
    } catch (caught) { setFeedback({ provider, kind: "error", text: caught instanceof Error ? caught.message : "Unable to save API key." }); }
    finally { setState(null); }
  };

  const remove = async (provider: "openai" | "google") => {
    if (!window.confirm("Remove this provider key? Future generations using this provider will stop working.")) return;
    setState({ provider, kind: "removing" }); setFeedback(null);
    try {
      const response = await fetch(`/api/settings/providers?provider=${provider}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to remove API key.");
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, configured: false, availability: "unknown", validation: "not_run", updatedAt: null } : row)); setFeedback({ provider, kind: "success", text: "API key removed." });
    } catch (caught) { setFeedback({ provider, kind: "error", text: caught instanceof Error ? caught.message : "Unable to remove API key." }); }
    finally { setState(null); }
  };

  const busy = state !== null;
  const retry = () => { void load(); };

  return <div className="space-y-4 p-5">
    <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-subtle)] text-[var(--accent)]"><KeyRound className="size-5" /></span><div><h2 className="font-semibold">AI providers</h2><p className="text-sm text-[var(--muted)]">Keys are stored per workspace and never sent back to the browser.</p></div></div>
    {loadStatus === "loading" && <div className="flex items-center gap-2 text-sm text-[var(--muted)]"><LoaderCircle className="size-4 animate-spin" />Loading provider settings…</div>}
    {loadStatus === "error" && <div role="alert" className="flex items-center justify-between rounded-xl border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3 text-sm text-[var(--danger)]"><span>Unable to load provider settings.</span><button type="button" onClick={retry} className="studio-button-secondary text-xs">Retry</button></div>}
    {loadStatus === "ready" && rows.map((row) => <section key={row.provider} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="font-medium">{row.label}</p><p className="mt-1 text-xs leading-5 text-[var(--muted)]">{row.hint}</p></div><span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${row.configured ? "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning)]" : "bg-[var(--surface-hover)] text-[var(--muted)]"}`}>{row.configured ? "Configured · validation pending" : "Not configured"}</span></div><div className="mt-3 flex gap-2"><div className="relative min-w-0 flex-1"><input className="studio-control pr-16" type={reveal[row.provider] ? "text" : "password"} value={drafts[row.provider] ?? ""} onChange={(e) => setDrafts((current) => ({ ...current, [row.provider]: e.target.value }))} placeholder={row.keyPlaceholder} disabled={busy} aria-label={`${row.label} API key`} /><button type="button" className="absolute right-1 top-1/2 -translate-y-1/2 p-2 text-[var(--muted)] hover:text-[var(--text)]" onClick={() => setReveal((current) => ({ ...current, [row.provider]: !current[row.provider] }))} aria-label={reveal[row.provider] ? "Hide API key" : "Show API key"} disabled={busy}>{reveal[row.provider] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div><button type="button" className="studio-button-primary" onClick={() => void save(row.provider)} disabled={busy || loadStatus !== "ready" || !drafts[row.provider]?.trim()}>{state?.provider === row.provider && state.kind === "saving" ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />} Save</button><button type="button" className="studio-button-secondary" onClick={() => void remove(row.provider)} disabled={busy || loadStatus !== "ready" || !row.configured}>{state?.provider === row.provider && state.kind === "removing" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove</button></div>{feedback?.provider === row.provider && <p role={feedback.kind === "error" ? "alert" : "status"} className={`mt-2 text-xs ${feedback.kind === "error" ? "text-[var(--danger)]" : "text-[var(--success)]"}`}>{feedback.text}</p>}</section>)}
  {feedback?.provider === "all" && <p role="alert" className="text-xs text-[var(--danger)]">{feedback.text}</p>}
  </div>;
}
