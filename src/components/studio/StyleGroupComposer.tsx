"use client";

import { ChevronDown, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { AiJobSchema, isTerminalStatus, type AiJob } from "@/db/ai-jobs";
import { useAiJob } from "@/lib/ai/use-ai-job";
import { StylePlanPreview } from "@/components/studio/StylePlanPreview";
import { StudioDialog } from "@/components/studio/StudioDialog";
import type { ExecutionPlan } from "@/lib/ai/execution-plan";

export type ComposerReference = { id: string; content_hash: string | null; signed_url: string | null };
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
  onSubmitted?: () => void;
}) {
  const [prompt, setPrompt] = useState(sourceVersion?.prompt ?? "");
  const [modelId, setModelId] = useState(models.find((model) => model.id === "openai/gpt-image-2")?.id ?? models[0]?.id ?? "");
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyPlan, setReadyPlan] = useState<ReadyPlan | null>(null);
  const [readyRevision, setReadyRevision] = useState(-1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submittedHere, setSubmittedHere] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { job, setJob } = useAiJob(initialJob);
  const inputRevisionRef = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const confirmRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);

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

  const resolvePlan = async (): Promise<ResolvedPlan | null> => {
    if (!prompt.trim() || !selectedModel || busyRef.current) return null;
    const revision = inputRevisionRef.current;
    busyRef.current = true;
    setError(null);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch("/api/ai-execution-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, requestedModelId: modelId, styleId, sourceVersionId: sourceVersion?.id, prompt: prompt.trim(), costMode: "strict_style", count, size, quality, preserveRequestedModel: true }),
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
      busyRef.current = false;
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
    busyRef.current = true;
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
      if (parsed.success) { setJob(parsed.data); setSubmittedHere(true); onSubmitted?.(); }
      else setError("The server returned an unexpected job response");
    } catch {
      setError("NETWORK_ERROR: Unable to start generation");
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  };

  // The gallery above is the visual result surface; this only links to the
  // images this job produced, because the job output carries ids, not previews.
  const resultAssetIds = (Array.isArray(job?.output?.results) ? job.output.results as Array<Record<string, unknown>> : [])
    .map((result) => (typeof result.asset_id === "string" ? result.asset_id : null))
    .filter((value): value is string => value !== null);

  return (
    <div className={embedded ? "space-y-5" : "min-h-dvh bg-[var(--canvas)] text-[var(--text)]"}>
      {!embedded && (
        <header className="flex h-14 items-center gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-4">
          <a href={`/style/${styleId}`} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">{styleName}</a>
          <span className="text-[var(--muted)]">/</span>
          <h1 className="font-semibold">Create new image</h1>
          {sourceVersion && <span className="ml-2 rounded-full bg-[var(--accent-subtle)] px-2 py-0.5 text-xs text-[var(--accent)]">Variant</span>}
        </header>
      )}
      <div className={embedded ? "space-y-5" : "mx-auto max-w-2xl space-y-6 p-5 sm:p-8"}>
        <div>
          <label className="studio-label" htmlFor="style-generation-prompt">What would you like to create?</label>
          <textarea
            id="style-generation-prompt"
            className="studio-control mt-1 min-h-24 w-full"
            placeholder={operation === "image_to_image" ? "Describe how this variation should differ…" : "Describe the image you want to create…"}
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value); invalidate(); }}
            maxLength={8000}
          />
          <p className="mt-1 text-right text-xs text-[var(--muted)]">{prompt.length}/8000</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="studio-label" htmlFor="style-generation-size">Aspect ratio</label>
            <select id="style-generation-size" className="studio-control w-full" value={size} onChange={(event) => { setSize(event.target.value); invalidate(); }}>
              {(selectedModel?.sizes ?? ["1024x1024"]).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
          <div>
            <label className="studio-label" htmlFor="style-generation-count">Number of images</label>
            <select id="style-generation-count" className="studio-control w-full" value={count} onChange={(event) => { setCount(Number(event.target.value) as 1 | 2 | 3 | 4); invalidate(); }}>
              {[1, 2, 3, 4].filter((option) => option <= (selectedModel?.maxCount ?? 4)).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
        </div>

        <details className="studio-card p-4" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium"><ChevronDown className="size-4" aria-hidden /> Advanced</summary>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="studio-label" htmlFor="style-generation-model">Model</label>
              <select id="style-generation-model" className="studio-control w-full" value={modelId} onChange={(event) => { const next = models.find((model) => model.id === event.target.value); if (!next) return; setModelId(next.id); setSize(next.sizes[0]); setQuality(next.qualities[0]); invalidate(); }}>
                <option value="" disabled>Select a model</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </div>
            <div>
              <label className="studio-label" htmlFor="style-generation-quality">Quality</label>
              <select id="style-generation-quality" className="studio-control w-full" value={quality} onChange={(event) => { setQuality(event.target.value); invalidate(); }}>
                {(selectedModel?.qualities ?? ["auto"]).map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>
          </div>
        </details>

        <div className="studio-card p-4">
          <p className="studio-label">Style references used</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            These images define rendering, palette, lighting and materials — not the subject you asked for.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {references.map((reference) => (
              <li key={reference.id} className="size-16 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-hover)]">
                {reference.signed_url
                  ? <img src={reference.signed_url} alt="Style reference" className="h-full w-full object-cover" />
                  : <span className="flex h-full items-center justify-center px-1 text-center text-[10px] text-[var(--muted)]">Preview unavailable</span>}
              </li>
            ))}
          </ul>
        </div>

        {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}

        {running && job && (
          <p aria-live="polite" className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <LoaderCircle className="size-4 animate-spin text-[var(--accent)]" /> Generating — this can take a minute.
          </p>
        )}

        {job && !running && (
          <div className="space-y-3">
            {job.status === "succeeded" ? (
              <>
                <p className="text-sm text-[var(--success)]">
                  {submittedHere ? "Image created. It is in the gallery above." : "Your last generation finished. It is in the gallery above."}
                </p>
                {resultAssetIds.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {resultAssetIds.map((assetId, index) => (
                      <li key={assetId}>
                        <a href={`/style/${styleId}/assets/${assetId}`} className="studio-button-secondary min-h-11 px-3 text-xs">
                          View image {index + 1}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-[var(--danger)]">
                  {submittedHere ? "" : "Your last generation failed. "}
                  {job.error_message || (job.status === "canceled" ? "Generation was canceled." : "Generation failed.")}
                </p>
                {/* A reloaded page shows the previous attempt; make the state
                    current and give the user the next action. */}
                {!submittedHere && job.status === "failed" && (
                  <button type="button" className="studio-button-secondary" onClick={() => setJob(null)}>
                    Try again
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <button onClick={() => void review()} disabled={!prompt.trim() || !selectedModel || submitting || running || busyRef.current || !confirmedRevision} className="studio-button-primary w-full">
          {busyRef.current ? <><LoaderCircle className="size-4 animate-spin" /> Preparing…</> : "Generate"}
        </button>
        {!confirmedRevision && <p className="text-xs text-[var(--muted)]">Confirm this style's references and analysis before generating images.</p>}
      </div>

      <StudioDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        label="Confirm generation"
        initialFocusRef={confirmRef}
        dismissible
        className="studio-card w-full max-w-lg p-6"
        style={{ position: "fixed" } as React.CSSProperties}
      >
        <div ref={confirmRef as React.RefObject<HTMLDivElement>} className="space-y-4">
          <h2 className="font-semibold">Confirm generation</h2>
          <dl className="space-y-1 text-sm text-[var(--muted)]">
            <div className="flex justify-between gap-4"><dt>Model</dt><dd className="text-[var(--text)]">{selectedModel?.label ?? modelId}</dd></div>
            <div className="flex justify-between gap-4"><dt>References</dt><dd className="text-[var(--text)]">{references.length}</dd></div>
            <div className="flex justify-between gap-4"><dt>Images</dt><dd className="text-[var(--text)]">{count} · {size} · {quality}</dd></div>
          </dl>
          {readyPlan && <StylePlanPreview plan={readyPlan} />}
          <p className="text-xs text-[var(--muted)]">Generation is billed by your provider for each image.</p>
          {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
          <div className="flex gap-2">
            <button className="studio-button-secondary flex-1" onClick={() => setConfirmOpen(false)} disabled={submitting}>Cancel</button>
            <button className="studio-button-primary flex-1" onClick={() => void submit()} disabled={submitting}>
              {submitting ? <><LoaderCircle className="size-4 animate-spin" /> Starting…</> : "Confirm generation"}
            </button>
          </div>
        </div>
      </StudioDialog>
    </div>
  );
}
