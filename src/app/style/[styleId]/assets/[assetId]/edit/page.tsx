"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { LoaderCircle, Paintbrush } from "lucide-react";
import MaskEditor from "@/components/editor/MaskEditor";
import { INPAINT_MODELS } from "@/lib/ai/models";
import { AiJobSchema, isTerminalStatus, type SupportedModelId, type SupportedQuality } from "@/db/ai-jobs";
import type { ExecutionPlan } from "@/lib/ai/execution-plan";
import { StylePlanPreview } from "@/components/studio/StylePlanPreview";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useAiJob } from "@/lib/ai/use-ai-job";
import { JOB_STATUS_LABELS } from "@/lib/ai/presentation";

type PlanPreview = ExecutionPlan & { planHash: string };
type ReadyPreview = { plan: PlanPreview; maskId: string; inputRevision: number; useCurrentStyle: boolean };
type StyleReference = { id: string; signed_url: string | null };

const SNAPSHOT_CHOICE_CODE = "STYLE_SOURCE_SNAPSHOT_REQUIRED";

export default function StyleInpaintPage() {
  const params = useParams<{ styleId: string; assetId: string }>();
  const router = useRouter();
  const [version, setVersion] = useState<{ id: string; width: number; height: number } | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [styleName, setStyleName] = useState("");
  const [references, setReferences] = useState<StyleReference[]>([]);
  const [maskPng, setMaskPng] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [adoptCurrentStyle, setAdoptCurrentStyle] = useState(false);
  const models = INPAINT_MODELS.filter((model) => model.operations.includes("inpaint"));
  const [modelId, setModelId] = useState<SupportedModelId>(models[0]?.id ?? "openai/gpt-image-2");
  const selected = models.find((model) => model.id === modelId) ?? models[0];
  const [quality, setQuality] = useState<SupportedQuality>(selected?.qualities[0] ?? "auto");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [readyPreview, setReadyPreview] = useState<ReadyPreview | null>(null);

  const { job, setJob } = useAiJob(null);
  const inputRevisionRef = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const invalidate = () => { inputRevisionRef.current += 1; setReadyPreview(null); };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);

  useEffect(() => {
    Promise.all([
      fetch(`/api/assets/${params.assetId}`).then((r) => r.json()),
      fetch(`/api/styles/${params.styleId}`).then((r) => r.json()),
    ])
      .then(([assetData, styleData]) => {
        if (!mountedRef.current) return;
        setVersion(assetData.version);
        setSignedUrl(assetData.signed_url);
        setStyleName(styleData.style?.name ?? "");
        const styleReferences = Array.isArray(styleData.style?.references)
          ? (styleData.style.references as Array<{ id: string; signed_url: string | null }>)
          : [];
        setReferences(styleReferences.map((reference) => ({ id: reference.id, signed_url: reference.signed_url ?? null })));
      })
      .catch(() => { if (mountedRef.current) setError("Failed to load asset"); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [params.assetId, params.styleId]);

  const terminal = job ? isTerminalStatus(job.status) : false;
  // Both terminal outcomes are derived during render, so the effect only navigates.
  const results = job && job.status === "succeeded" && Array.isArray(job.output?.results) ? job.output.results : [];
  const firstResult = results[0];
  const candidateVersionId = job && job.status === "succeeded"
    ? (firstResult && typeof firstResult === "object" && "version_id" in firstResult && typeof firstResult.version_id === "string" ? firstResult.version_id : null) ?? job.version_id ?? null
    : null;
  const jobError = job?.status === "failed"
    ? job.error_message || "The edit failed. Your mask and prompt are unchanged."
    : job?.status === "succeeded" && !candidateVersionId
      ? "The edit finished but no candidate version was recorded."
      : null;

  useEffect(() => {
    if (!job || job.status !== "succeeded" || !candidateVersionId) return;
    router.push(`/style/${params.styleId}/assets/${params.assetId}?version=${candidateVersionId}&review=1`);
  }, [job, candidateVersionId, params.assetId, params.styleId, router]);

  const preview = async (useCurrentStyle: boolean) => {
    if (!maskPng || !version || !prompt.trim() || busyRef.current) return;
    const revision = inputRevisionRef.current;
    busyRef.current = true;
    setPreviewing(true);
    setError(null);
    setErrorCode(null);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const maskRes = await fetch(`/api/assets/${params.assetId}/masks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentVersionId: version.id, maskPng }),
        signal: controller.signal,
      });
      const maskBody = await maskRes.json();
      if (!maskRes.ok) throw new Error(`${maskBody.error?.code ?? "MASK_FAILED"}: ${maskBody.error?.message ?? "Mask upload failed"}`);
      if (typeof maskBody.maskId !== "string") throw new Error("MASK_FAILED: the mask upload did not return an id");
      if (!mountedRef.current || inputRevisionRef.current !== revision) return;
      const planRes = await fetch("/api/ai-execution-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "inpaint", requestedModelId: modelId, styleId: params.styleId, sourceAssetId: params.assetId, sourceVersionId: version.id, maskId: maskBody.maskId, prompt: prompt.trim(), quality, size: "auto", count: 1, referenceIds: [], preserveRequestedModel: true, useCurrentStyle }),
        signal: controller.signal,
      });
      const planBody = await planRes.json();
      if (!planRes.ok) {
        const code = typeof planBody.error?.code === "string" ? planBody.error.code : "PLAN_FAILED";
        if (mountedRef.current) setErrorCode(code);
        throw new Error(`${code}: ${planBody.error?.message ?? "Unable to resolve the edit plan"}`);
      }
      if (!mountedRef.current || inputRevisionRef.current !== revision) return;
      const plan = planBody.plan as PlanPreview | undefined;
      if (!plan || typeof plan.planHash !== "string" || plan.planHash.length === 0) throw new Error("PLAN_FAILED: the plan did not include a consent hash");
      setReadyPreview({ plan, maskId: maskBody.maskId, inputRevision: revision, useCurrentStyle });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : "Unable to preview the edit");
    } finally {
      busyRef.current = false;
      setPreviewing(false);
    }
  };

  const submit = async () => {
    if (!maskPng || !version || !prompt.trim() || !readyPreview || busyRef.current) return;
    if (readyPreview.inputRevision !== inputRevisionRef.current) { invalidate(); return; }
    busyRef.current = true;
    setSubmitting(true);
    setError(null);
    setErrorCode(null);
    try {
      const jobRes = await fetch(`/api/assets/${params.assetId}/ai-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "inpaint", model: modelId, parentVersionId: version.id, maskId: readyPreview.maskId, prompt: prompt.trim(), quality, consent: { planHash: readyPreview.plan.planHash }, referenceIds: [], useCurrentStyle: readyPreview.useCurrentStyle }),
      });
      const jobBody = await jobRes.json();
      const code = typeof jobBody.error?.code === "string" ? jobBody.error.code : null;
      if (jobRes.status === 409 && (code === "PLAN_CONSENT_MISMATCH" || jobBody.error?.plan)) {
        setError("The plan changed since it was previewed. Preview the edit again before applying it.");
        setReadyPreview(null);
        return;
      }
      if (!jobRes.ok) {
        if (mountedRef.current) setErrorCode(code);
        throw new Error(`${code ?? "SUBMIT_FAILED"}: ${jobBody.error?.message ?? "The edit could not be queued"}`);
      }
      const parsed = AiJobSchema.safeParse(jobBody.job);
      if (parsed.success) setJob(parsed.data);
      else setError("The server returned an unexpected job response.");
    } catch (caught) {
      if (caught instanceof Error) setError(caught.message);
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  };

  const chooseCurrentStyle = () => {
    setAdoptCurrentStyle(true);
    invalidate();
    setError(null);
    setErrorCode(null);
  };

  const jobRunning = job !== null && !terminal;
  const planReferenceIds = readyPreview?.plan.referenceIds ?? null;
  const thumbnails = planReferenceIds
    ? planReferenceIds.map((id) => references.find((reference) => reference.id === id) ?? { id, signed_url: null })
    : references;
  const canSubmit = Boolean(maskPng) && prompt.trim().length > 0 && !submitting && !previewing && !jobRunning;

  if (loading) return <div className="flex min-h-dvh items-center justify-center bg-background"><LoaderCircle className="size-6 animate-spin text-primary" /></div>;
  if (!version || !signedUrl) return <div className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground">Asset not found</div>;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-2">
        <a href={`/style/${params.styleId}/assets/${params.assetId}`} className="truncate text-sm text-muted-foreground hover:text-foreground">{styleName || "Style asset"}</a>
        <span className="text-muted-foreground">/</span>
        <h1 className="flex items-center gap-2 font-semibold"><Paintbrush className="size-4 text-primary" />Edit image</h1>
      </header>

      <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <section aria-labelledby="paint-step" className="min-w-0 space-y-2">
          <h2 id="paint-step" className="text-sm font-semibold">1. Paint the area</h2>
          <p className="text-xs text-muted-foreground">Paint the region to change. Restore removes a painted area, Invert flips which part of the image is edited, and the mask is exported automatically.</p>
          <div className="h-[60vh] min-h-[22rem] overflow-hidden rounded-lg border border-border lg:h-[calc(100dvh-12rem)]">
            <MaskEditor
              imageUrl={signedUrl}
              width={version.width}
              height={version.height}
              onMaskChange={(png) => { setMaskPng(png); setReadyPreview(null); }}
              onDirty={() => { invalidate(); setMaskPng(null); }}
            />
          </div>
        </section>

        <aside className="min-w-0 space-y-4">
          <Card aria-labelledby="describe-step">
            <CardContent className="space-y-3">
            <h2 id="describe-step" className="text-sm font-semibold">2. Describe the change</h2>
            <div className="space-y-2">
              <Label htmlFor="edit-instruction" className="text-xs font-semibold">Instruction</Label>
              <Textarea id="edit-instruction" className="min-h-24" placeholder="Describe the edit for the painted area" value={prompt} onChange={(event) => { setPrompt(event.target.value); invalidate(); }} maxLength={8000} />
            </div>
            <p className="text-xs text-muted-foreground">Uses the original image&apos;s style.</p>
            <ul className="flex flex-wrap gap-2" aria-label="Style references">
              {thumbnails.map((reference) => (
                <li key={reference.id} className="size-14 overflow-hidden rounded-lg border border-border bg-accent">
                  {reference.signed_url
                    ? <Image src={reference.signed_url} alt="Style reference" width={64} height={64} sizes="64px" className="size-full object-cover" />
                    : <span className="flex size-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground">No preview</span>}
                </li>
              ))}
            </ul>
            {thumbnails.length === 0 && <p className="text-xs text-muted-foreground">No style references are available to preview.</p>}
            {adoptCurrentStyle && <p role="status" className="text-xs text-warning">This image predates its style definition, so the confirmed current style is applied to the edited area.</p>}
            <Collapsible className="rounded-lg border border-border p-3">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-start text-xs font-semibold text-muted-foreground">
                  <ChevronDown className="size-3.5" />Advanced
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Model</Label>
                  <Select value={modelId} onValueChange={(value) => { const next = models.find((model) => model.id === value); if (!next) return; setModelId(next.id); setQuality(next.qualities[0]); invalidate(); }}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Quality</Label>
                  <Select value={quality} onValueChange={(value) => { setQuality(value as SupportedQuality); invalidate(); }}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{selected?.qualities.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </CollapsibleContent>
            </Collapsible>
            </CardContent>
          </Card>

          <Card aria-labelledby="review-step">
            <CardContent className="space-y-3">
            <h2 id="review-step" className="text-sm font-semibold">3. Review edit</h2>
            {readyPreview ? <StylePlanPreview plan={readyPreview.plan} /> : <p className="text-xs text-muted-foreground">Preview the edit to see the model, reference count and settings that will be used before anything is submitted.</p>}
            {jobRunning && job && <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-primary"><LoaderCircle className="size-4 animate-spin" />{JOB_STATUS_LABELS[job.status]} · your mask and instruction stay editable while this runs.</p>}
            {errorCode === SNAPSHOT_CHOICE_CODE && (
              <Alert role="alert" variant="default" className="border-warning/35 bg-warning/10">
                <AlertDescription>
                  <p className="text-xs text-warning">This image was generated before its style was recorded, so the style used for it cannot be recovered from it.</p>
                  <Button type="button" variant="outline" className="mt-3 w-full" onClick={chooseCurrentStyle}>Use the confirmed current style</Button>
                  <p className="mt-2 text-xs text-muted-foreground">Preview the edit again to confirm this choice before it is applied.</p>
                </AlertDescription>
              </Alert>
            )}
            {(error ?? jobError) && <p role="alert" className="text-xs text-destructive">{error ?? jobError}</p>}
            <Button
              type="button"
              onClick={() => { if (readyPreview) void submit(); else void preview(adoptCurrentStyle); }}
              disabled={!canSubmit}
              className="w-full"
            >
              {previewing ? <><LoaderCircle className="size-4 animate-spin" />Preparing plan…</> : submitting ? <><LoaderCircle className="size-4 animate-spin" />Applying…</> : jobRunning ? <><LoaderCircle className="size-4 animate-spin" />Editing…</> : readyPreview ? "Confirm and apply edit" : "Preview edit plan"}
            </Button>
            <p role="status" className="text-xs text-muted-foreground">
              {!maskPng ? "Paint an edit area to continue." : prompt.trim().length === 0 ? "Describe the change to continue." : readyPreview ? "The instruction, mask and settings above are what will be submitted." : "Nothing is submitted until you confirm the previewed plan."}
            </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
