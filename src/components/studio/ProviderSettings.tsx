"use client";

import { Check, Eye, EyeOff, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

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
    <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><KeyRound className="size-5" /></span><div className="min-w-0"><h2 className="font-semibold">AI providers</h2><p className="text-sm text-muted-foreground">Keys are stored per workspace and never sent back to the browser.</p></div></div>
    {loadStatus === "loading" && <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading provider settings…</div>}
    {loadStatus === "error" && <Alert variant="destructive" className="flex items-center justify-between gap-3"><AlertDescription>Unable to load provider settings.</AlertDescription><Button variant="outline" size="sm" className="text-xs" onClick={retry}>Retry</Button></Alert>}
    {loadStatus === "ready" && rows.map((row) => <Card key={row.provider} className="gap-3 py-4">
      <CardHeader className="flex flex-row items-start justify-between gap-3 px-4">
        <div className="min-w-0">
          <CardTitle className="font-medium">{row.label}</CardTitle>
          <CardDescription className="mt-1 text-xs leading-5">{row.hint}</CardDescription>
        </div>
        <Badge variant="secondary" role="status" aria-live="polite" className={row.configured ? "bg-warning/10 text-warning" : "text-muted-foreground"}>{row.configured ? "Configured · validation pending" : "Not configured"}</Badge>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <Label htmlFor={`provider-${row.provider}`} className="text-xs font-semibold tracking-wide text-muted-foreground">{`${row.label} API key`}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Input id={`provider-${row.provider}`} className="pr-12" type={reveal[row.provider] ? "text" : "password"} value={drafts[row.provider] ?? ""} onChange={(e) => setDrafts((current) => ({ ...current, [row.provider]: e.target.value }))} placeholder={row.keyPlaceholder} disabled={busy} aria-label={`${row.label} API key`} />
            <Button type="button" variant="ghost" size="icon" className="absolute top-1/2 right-0 -translate-y-1/2" onClick={() => setReveal((current) => ({ ...current, [row.provider]: !current[row.provider] }))} aria-label={reveal[row.provider] ? "Hide API key" : "Show API key"} disabled={busy}>{reveal[row.provider] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
          </div>
          <Button type="button" onClick={() => void save(row.provider)} disabled={busy || loadStatus !== "ready" || !drafts[row.provider]?.trim()}>{state?.provider === row.provider && state.kind === "saving" ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />} Save</Button>
          <Button type="button" variant="destructive" onClick={() => void remove(row.provider)} disabled={busy || loadStatus !== "ready" || !row.configured}>{state?.provider === row.provider && state.kind === "removing" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove</Button>
        </div>
        {feedback?.provider === row.provider && <p role={feedback.kind === "error" ? "alert" : "status"} className={cn("text-xs", feedback.kind === "error" ? "text-destructive" : "text-success")}>{feedback.text}</p>}
      </CardContent>
    </Card>)}
    {feedback?.provider === "all" && <p role="alert" className="text-xs text-destructive">{feedback.text}</p>}
  </div>;
}
