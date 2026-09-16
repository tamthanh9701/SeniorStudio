"use client";

import { ChevronDown, LoaderCircle, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { AiJobSchema, isTerminalStatus, type AiJob } from "@/db/ai-jobs";
import { useAiJob } from "@/lib/ai/use-ai-job";
import { StylePlanPreview } from "@/components/studio/StylePlanPreview";
import type { ExecutionPlan } from "@/lib/ai/execution-plan";

/** How many library images one request may borrow. */
const MAX_LIBRARY_REFERENCES = 8;

export type ComposerReference = { id: string; content_hash: string | null; signed_url: string | null };
export type LibraryReference = { id: string; styleId: string; styleName: string; signedUrl: string };
type SourceVersion = { id: string; prompt: string | null; metadata: Record<string, unknown> };

type ReadyPlan = ExecutionPlan & { styleRevision: string; compiledPrompt: string; planHash: string; warnings?: string[] };
type ResolvedPlan = { plan: ReadyPlan; revision: number };

/**
 * Generation form for one style.
 *
 * The confirmed definition supplies the schema and the reference images, so the
 * user only chooses what to make.  Model and quality stay under Advanced to keep
 * the primary path to one decision.
 */
export default function StyleGroupComposer({
  styleId,
  styleName,
  models,
  references,
  confirmedRevision,
  sourceVersion,
  embedded = false,
  initialJob = null,
  initialPrompt = null,
  sourceLabel = null,
  onSubmitted,
}: {
  styleId: string;
  styleName: string;
  models: ModelCatalogEntry[];
  references: ComposerReference[];
  confirmedRevision: string | null;
  sourceVersion: SourceVersion | null;
  /** Rendered inside the style workspace instead of as a standalone page. */
  embedded?: boolean;
  initialJob?: AiJob | null;
  /** Prefills the form after a failed attempt so the user can retry it. */
  initialPrompt?: string | null;
  /** Name of the image this generation varies, when it is a variation. */
  sourceLabel?: string | null;
  onSubmitted?: (job: AiJob) => void;
}) {
  const [prompt, setPrompt] = useState(sourceVersion?.prompt ?? initialPrompt ?? "");
  const [modelId, setModelId] = useState(models.find((model) => model.id === "openai/gpt-image-2")?.id ?? models[0]?.id ?? "");
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyPlan, setReadyPlan] = useState<ReadyPlan | null>(null);
  const [readyRevision, setReadyRevision] = useState(-1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submittedHere, setSubmittedHere] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryOptions, setLibraryOptions] = useState<LibraryReference[]>([]);
  const [libraryRefs, setLibraryRefs] = useState<LibraryReference[]>([]);
  const { job, setJob } = useAiJob(initialJob);
  const inputRevisionRef = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  /**
   * A plan is being resolved. The ref is the re-entrancy guard across awaits
   * and the state is what render reads — a ref must not be read during render
   * — so both are written together and cannot drift apart.
   */
  const markBusy = (value: boolean) => {
    busyRef.current = value;
    setPreparing(value);
  };

  useEffect(() => {
    if (initialPrompt) setPrompt(initialPrompt);
  }, [initialPrompt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);

  const selectedModel = useMemo(() => models.find((model) => model.id === modelId), [models, modelId]);
  const operation = sourceVersion ? "image_to_image" as const : "text_to_image" as const;
  const running = job !== null && !isTerminalStatus(job.status);

  /**
   * Any change invalidates consent: the plan the user approved no longer
   * matches.  A monotonic revision is used rather than a value snapshot because
   * the change handler runs before the new state is committed.
   */
  const invalidate = useCallback(() => {
    inputRevisionRef.current += 1;
    setReadyPlan(null);
    setConfirmOpen(false);
  }, []);

  const openLibrary = async () => {
    setLibraryOpen(true);
    invalidate();
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const response = await fetch(`/api/styles/${styleId}/references/library`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setLibraryError(`${body.error?.code ?? "LOAD_FAILED"}: ${body.error?.message ?? "Unable to load library references"}`);
        return;
      }
      setLibraryOptions(Array.isArray(body.references) ? (body.references as LibraryReference[]) : []);
    } catch {
      setLibraryError("NETWORK_ERROR: Unable to load library references");
    } finally {
      setLibraryLoading(false);
    }
  };

  const atLibraryCap = libraryRefs.length >= MAX_LIBRARY_REFERENCES;

  const toggleLibraryReference = (reference: LibraryReference) => {
    invalidate();
    setLibraryRefs((current) => {
      if (current.some((entry) => entry.id === reference.id)) return current.filter((entry) => entry.id !== reference.id);
      if (current.length >= MAX_LIBRARY_REFERENCES) return current;
      return [...current, reference];
    });
  };

  const resolvePlan = async (): Promise<ResolvedPlan | null> => {
    if (!prompt.trim() || !selectedModel || busyRef.current) return null;
    const revision = inputRevisionRef.current;
    markBusy(true);
    setError(null);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch("/api/ai-execution-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, requestedModelId: modelId, styleId, sourceVersionId: sourceVersion?.id, prompt: prompt.trim(), libraryReferenceIds: libraryRefs.map((reference) => reference.id), costMode: "strict_style", count, size, quality, preserveRequestedModel: true }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!mountedRef.current || inputRevisionRef.current !== revision) return null;
      if (!response.ok) {
        setError(`${body.error?.code ?? "PLAN_FAILED"}: ${body.error?.message ?? "Unable to resolve the generation plan"}`);
        return null;
      }
      return { plan: body.plan as ReadyPlan, revision };
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return null;
      if (mountedRef.current) setError("NETWORK_ERROR: Unable to resolve the generation plan");
      return null;
    } finally {
      markBusy(false);
    }
  };

  const review = async () => {
    const resolved = await resolvePlan();
    if (!resolved) return;
    setReadyPlan(resolved.plan);
    setReadyRevision(resolved.revision);
    setConfirmOpen(true);
  };

  const submit = async () => {
    if (!readyPlan || busyRef.current) return;
    if (readyRevision !== inputRevisionRef.current) { invalidate(); return; }
    markBusy(true);
    setSubmitting(true);
    setError(null);
    try {
      const jobRes = await fetch(`/api/styles/${styleId}/ai-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation,
          model: modelId,
          prompt: prompt.trim(),
          sourceVersionId: sourceVersion?.id ?? undefined,
          size,
          quality,
          count,
          costMode: "strict_style",
          libraryReferenceIds: libraryRefs.map((reference) => reference.id),
          consent: { planHash: readyPlan.planHash },
        }),
      });
      const jobBody = await jobRes.json().catch(() => ({}));
      if (!jobRes.ok) {
        // Consent is never renewed automatically: the user must see the new plan.
        setConfirmOpen(false);
        setReadyPlan(null);
        setError(`${jobBody.error?.code ?? "SUBMIT_FAILED"}: ${jobBody.error?.message ?? "Unable to start generation"}`);
        return;
      }
      const parsed = AiJobSchema.safeParse(jobBody.job);
      if (parsed.success) { setJob(parsed.data); setSubmittedHere(true); onSubmitted?.(parsed.data); }
      else setError("The server returned an unexpected job response");
    } catch {
      setError("NETWORK_ERROR: Unable to start generation");
    } finally {
      markBusy(false);
      setSubmitting(false);
    }
  };

  // The gallery above is the visual result surface; this only links to the
  // images this job produced, because the job output carries ids, not previews.
  const resultAssetIds = (Array.isArray(job?.output?.results) ? job.output.results as Array<Record<string, unknown>> : [])
    .map((result) => (typeof result.asset_id === "string" ? result.asset_id : null))
    .filter((value): value is string => value !== null);

  return (
    <div className={embedded ? "space-y-5" : "min-h-dvh bg-background text-foreground"}>
      {!embedded && (
        <header className="flex h-14 items-center gap-4 border-b border-border bg-muted px-4">
          <a href={`/style/${styleId}`} className="text-sm text-muted-foreground hover:text-foreground">{styleName}</a>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-semibold">Create new image</h1>
          {sourceVersion && <Badge variant="secondary" className="ml-2 bg-primary/10 text-primary">Variant</Badge>}
        </header>
      )}
      <div className={embedded ? "space-y-5" : "mx-auto max-w-2xl space-y-6 p-5 sm:p-8"}>
        <div>
          <Label htmlFor="style-generation-prompt" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">What would you like to create?</Label>
          <Textarea
            id="style-generation-prompt"
            className="mt-1 min-h-24 w-full"
            placeholder={operation === "image_to_image" ? "Describe how this variation should differ…" : "Describe the image you want to create…"}
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value); invalidate(); }}
            maxLength={8000}
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">{prompt.length}/8000</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <Label htmlFor="style-generation-size" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Aspect ratio</Label>
            <Select value={size} onValueChange={(value) => { setSize(value); invalidate(); }}>
              <SelectTrigger id="style-generation-size" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(selectedModel?.sizes ?? ["1024x1024"]).map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label htmlFor="style-generation-count" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Number of images</Label>
            <Select value={String(count)} onValueChange={(value) => { setCount(Number(value) as 1 | 2 | 3 | 4); invalidate(); }}>
              <SelectTrigger id="style-generation-count" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].filter((option) => option <= (selectedModel?.maxCount ?? 4)).map((option) => <SelectItem key={option} value={String(option)}>{option}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="rounded-lg border border-border bg-card p-4">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="flex min-h-11 w-full items-center justify-start gap-2 text-sm font-medium">
              <ChevronDown className={cn("size-4 transition-transform", advancedOpen && "rotate-180")} aria-hidden />
              Advanced
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <Label htmlFor="style-generation-model" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Model</Label>
              <Select value={modelId} onValueChange={(value) => { const next = models.find((model) => model.id === value); if (!next) return; setModelId(next.id); setSize(next.sizes[0]); setQuality(next.qualities[0]); invalidate(); }}>
                <SelectTrigger id="style-generation-model" className="w-full">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <Label htmlFor="style-generation-quality" className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Quality</Label>
              <Select value={quality} onValueChange={(value) => { setQuality(value); invalidate(); }}>
                <SelectTrigger id="style-generation-quality" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(selectedModel?.qualities ?? ["auto"]).map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <Card className="gap-3 p-4">
          <Label className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">Style references used</Label>
          <p className="text-xs text-muted-foreground">
            These images define rendering, palette, lighting and materials — not the subject you asked for.
          </p>
          <ul className="flex flex-wrap gap-2">
            {references.map((reference) => (
              <li key={reference.id} className="size-16 overflow-hidden rounded-lg border border-border bg-accent">
                {reference.signed_url
                  ? <img src={reference.signed_url} alt="Style reference" className="h-full w-full object-cover" />
                  : <span className="flex h-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground">Preview unavailable</span>}
              </li>
            ))}
          </ul>
          {libraryRefs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Also sent from the library</p>
              <ul className="flex flex-wrap gap-2">
                {libraryRefs.map((reference) => (
                  <li key={reference.id} className="flex items-center gap-2 rounded-lg border border-border bg-accent py-1 pl-1 pr-2">
                    <img src={reference.signedUrl} alt={`${reference.styleName} reference`} className="size-10 rounded object-cover" />
                    <span className="max-w-32 truncate text-xs text-foreground">{reference.styleName}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${reference.styleName} reference`}
                      onClick={() => toggleLibraryReference(reference)}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* A variation keeps the references of the image it varies, so borrowing is not offered. */}
          {!sourceVersion && (
            <Button type="button" variant="outline" className="w-fit" onClick={() => void openLibrary()}>
              <Plus className="size-4" aria-hidden /> Choose from library
            </Button>
          )}
        </Card>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {running && job && (
          <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin text-primary" />
            Generating — this can take a minute.
          </p>
        )}

        {job && !running && (
          <div className="space-y-3">
            {job.status === "succeeded" ? (
              <>
                <Alert>
                  <AlertDescription className="text-success">
                    {submittedHere ? "Image created. It is in the gallery above." : "Your last generation finished. It is in the gallery above."}
                  </AlertDescription>
                </Alert>
                {resultAssetIds.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {resultAssetIds.map((assetId, index) => (
                      <li key={assetId}>
                        <Button asChild variant="outline">
                          <a href={`/style/${styleId}/assets/${assetId}`}>View image {index + 1}</a>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <Alert variant="destructive" role="alert">
                  <AlertDescription>
                    {submittedHere ? "" : "Your last generation failed. "}
                    {job.error_message || (job.status === "canceled" ? "Generation was canceled." : "Generation failed.")}
                  </AlertDescription>
                </Alert>
                {/* A reloaded page shows the previous attempt; make the state
                    current and give the user the next action. */}
                {!submittedHere && job.status === "failed" && (
                  <Button type="button" variant="outline" onClick={() => setJob(null)}>
                    Try again
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        <Button onClick={() => void review()} disabled={!prompt.trim() || !selectedModel || submitting || running || preparing || !confirmedRevision} className="w-full">
          {preparing ? <><LoaderCircle className="size-4 animate-spin" /> Preparing…</> : "Generate"}
        </Button>
        {!confirmedRevision && <p className="text-xs text-muted-foreground">Confirm this style&apos;s references and analysis before generating images.</p>}
      </div>

      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Choose references from the library</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Images from other styles in this library are sent alongside this style&apos;s own references. Up to {MAX_LIBRARY_REFERENCES}.
            </DialogDescription>
          </DialogHeader>
          <Input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search by style name" aria-label="Search library references" />
          {libraryError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="text-xs">{libraryError}</AlertDescription>
            </Alert>
          )}
          {libraryLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading the library…
            </p>
          )}
          {!libraryLoading && libraryOptions.length === 0 && !libraryError && (
            <p className="text-sm text-muted-foreground">This library has no other reference images yet.</p>
          )}
          {libraryOptions.length > 0 && (
            <ul className="grid max-h-80 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
              {libraryOptions
                .filter((option) => option.styleName.toLowerCase().includes(libraryQuery.trim().toLowerCase()))
                .map((option) => {
                  const selected = libraryRefs.some((entry) => entry.id === option.id);
                  // Selected tiles stay clickable so a slot can be freed again.
                  const atCap = !selected && atLibraryCap;
                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        disabled={atCap}
                        aria-label={`${selected ? "Remove" : "Add"} ${option.styleName} reference`}
                        onClick={() => toggleLibraryReference(option)}
                        className={cn("block w-full overflow-hidden rounded-lg border text-left transition", selected ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/60", atCap && "cursor-not-allowed opacity-50 hover:border-border")}
                      >
                        <img src={option.signedUrl} alt="" className="aspect-square w-full object-cover" />
                        <span className="block truncate px-2 py-1 text-xs text-muted-foreground">{option.styleName}</span>
                      </button>
                    </li>
                  );
                })}
            </ul>
          )}
          <p role="status" aria-live="polite" className="min-h-4 text-xs text-destructive">
            {atLibraryCap ? `Maximum ${MAX_LIBRARY_REFERENCES} selected` : ""}
          </p>
          <DialogFooter>
            <span className="mr-auto text-xs text-muted-foreground">{libraryRefs.length} selected</span>
            <Button type="button" onClick={() => { setLibraryOpen(false); invalidate(); }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Confirm generation</DialogTitle>
          </DialogHeader>
          <dl className="space-y-1 text-sm text-muted-foreground">
            <div className="flex justify-between gap-4"><dt>Model</dt><dd className="text-foreground">{selectedModel?.label ?? modelId}</dd></div>
            <div className="flex justify-between gap-4"><dt>References</dt><dd className="text-foreground">{references.length}{libraryRefs.length > 0 ? ` + ${libraryRefs.length} from the library` : ""}</dd></div>
            <div className="flex justify-between gap-4"><dt>Images</dt><dd className="text-foreground">{count} · {size} · {quality}</dd></div>
          </dl>
          {readyPlan && <StylePlanPreview plan={readyPlan} />}
          <DialogDescription className="text-xs">Generation is billed by your provider for each image.</DialogDescription>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={() => setConfirmOpen(false)} disabled={submitting}>Cancel</Button>
            <Button className="flex-1" onClick={() => void submit()} disabled={submitting}>
              {submitting ? <><LoaderCircle className="size-4 animate-spin" /> Starting…</> : "Confirm generation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
