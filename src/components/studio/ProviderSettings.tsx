"use client";

import { Check, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ProviderRow = { provider: "openai" | "google"; label: string; hint: string; keyPlaceholder: string; configured: boolean; validation: "not_run" | "passed" | "failed"; models?: number; imageModels?: number; updatedAt?: string | null };

const INITIAL: ProviderRow[] = [
  { provider: "openai", label: "OpenAI", hint: "Enables GPT Image generation and masked inpaint.", keyPlaceholder: "sk-…", configured: false, validation: "not_run" },
  { provider: "google", label: "Google AI Studio", hint: "Unlocks the dynamic Gemini image model catalog.", keyPlaceholder: "AIza…", configured: false, validation: "not_run" },
];

export default function ProviderSettings() {
  const [rows, setRows] = useState(INITIAL);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<{ provider: string; kind: "saving" | "removing" | "checking" } | null>(null);
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
        return saved ? { ...row, configured: true, validation: "not_run", updatedAt: saved.updatedAt } : row;
      }));
      setLoadStatus("ready");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (!mountedRef.current) return;
      setLoadStatus("error");
      setFeedback({ provider: "all", kind: "error", text: "Unable to load provider settings." });
    }
  }, []);

  // Deferred one tick: an effect that fetches synchronously would set state during the
  // first paint, and the retry button keeps its synchronous loading state.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = async (provider: "openai" | "google") => {
    setState({ provider, kind: "saving" }); setFeedback(null);
    try {
      const response = await fetch("/api/settings/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey: drafts[provider] ?? "" }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to save API key.");
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, configured: true, validation: "not_run", models: undefined, imageModels: undefined, updatedAt: new Date().toISOString() } : row));
      setDrafts((current) => ({ ...current, [provider]: "" }));
    } catch (caught) { setFeedback({ provider, kind: "error", text: caught instanceof Error ? caught.message : "Unable to save API key." }); setState(null); return; }
    setState(null);
    // A saved key is checked immediately: "validation pending" was a state nobody could
    // leave, because no request ever ran the validation.
    await check(provider);
  };

  const check = async (provider: "openai" | "google") => {
    setState({ provider, kind: "checking" }); setFeedback(null);
    try {
      const response = await fetch("/api/settings/providers/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to check this key.");
      if (body.ok !== true) {
        setRows((current) => current.map((row) => row.provider === provider ? { ...row, validation: "failed", models: undefined, imageModels: undefined } : row));
        setFeedback({ provider, kind: "error", text: `${body.code ?? "PROVIDER_REJECTED"}: ${body.message ?? "The provider rejected this key."}` });
        return false;
      }
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, validation: "passed", models: body.models, imageModels: body.imageModels } : row));
      const detail = provider === "google" && typeof body.imageModels === "number" ? `, ${body.imageModels} image model${body.imageModels === 1 ? "" : "s"}` : "";
      setFeedback({ provider, kind: "success", text: `Key verified: ${body.models ?? 0} models reachable${detail}.` });
      return true;
    } catch (caught) {
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, validation: "failed", models: undefined, imageModels: undefined } : row));
      setFeedback({ provider, kind: "error", text: caught instanceof Error ? caught.message : "Unable to check this key." });
      return false;
    } finally { setState(null); }
  };

  const remove = async (provider: "openai" | "google") => {
    if (!window.confirm("Remove this provider key? Future generations using this provider will stop working.")) return;
    setState({ provider, kind: "removing" }); setFeedback(null);
    try {
      const response = await fetch(`/api/settings/providers?provider=${provider}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to remove API key.");
      setRows((current) => current.map((row) => row.provider === provider ? { ...row, configured: false, validation: "not_run", models: undefined, imageModels: undefined, updatedAt: null } : row)); setFeedback({ provider, kind: "success", text: "API key removed." });
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
        <Badge
          variant="secondary"
          role="status"
          aria-live="polite"
          className={cn(
            "shrink-0",
            row.validation === "passed" ? "bg-success/10 text-success" : row.validation === "failed" ? "bg-destructive/10 text-destructive" : row.configured ? "bg-warning/10 text-warning" : "text-muted-foreground",
          )}
        >
          {!row.configured
            ? "Not configured"
            : row.validation === "passed"
              ? `Configured · verified${typeof row.imageModels === "number" ? ` · ${row.imageModels} image models` : typeof row.models === "number" ? ` · ${row.models} models` : ""}`
              : row.validation === "failed"
                ? "Configured · check failed"
                : "Configured · not checked"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <Label htmlFor={`provider-${row.provider}`} className="text-xs font-semibold tracking-wide text-muted-foreground">{`${row.label} API key`}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Input id={`provider-${row.provider}`} className="pr-12" type={reveal[row.provider] ? "text" : "password"} value={drafts[row.provider] ?? ""} onChange={(e) => setDrafts((current) => ({ ...current, [row.provider]: e.target.value }))} placeholder={row.keyPlaceholder} disabled={busy} aria-label={`${row.label} API key`} />
            <Button type="button" variant="ghost" size="icon" className="absolute top-1/2 right-0 -translate-y-1/2" onClick={() => setReveal((current) => ({ ...current, [row.provider]: !current[row.provider] }))} aria-label={reveal[row.provider] ? "Hide API key" : "Show API key"} disabled={busy}>{reveal[row.provider] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
          </div>
          <Button type="button" onClick={() => void save(row.provider)} disabled={busy || loadStatus !== "ready" || !drafts[row.provider]?.trim()}>{state?.provider === row.provider && state.kind === "saving" ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />} Save</Button>
          <Button type="button" variant="outline" onClick={() => void check(row.provider)} disabled={busy || loadStatus !== "ready" || !row.configured}>{state?.provider === row.provider && state.kind === "checking" ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Check</Button>
          <Button type="button" variant="destructive" onClick={() => void remove(row.provider)} disabled={busy || loadStatus !== "ready" || !row.configured}>{state?.provider === row.provider && state.kind === "removing" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove</Button>
        </div>
        {feedback?.provider === row.provider && <p role={feedback.kind === "error" ? "alert" : "status"} className={cn("text-xs", feedback.kind === "error" ? "text-destructive" : "text-success")}>{feedback.text}</p>}
      </CardContent>
    </Card>)}
    {feedback?.provider === "all" && <p role="alert" className="text-xs text-destructive">{feedback.text}</p>}
  </div>;
}
