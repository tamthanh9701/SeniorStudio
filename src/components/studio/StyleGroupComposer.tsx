"use client";

import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { AiJobSchema } from "@/db/ai-jobs";
import { useAiJob } from "@/lib/ai/use-ai-job";
import { StylePlanPreview } from "@/components/studio/StylePlanPreview";
import type { ExecutionPlan } from "@/lib/ai/execution-plan";

type Reference = { id: string; content_hash: string | null };
type SourceVersion = { id: string; prompt: string | null; metadata: Record<string, unknown> };

export default function StyleGroupComposer({
  styleId,
  styleName,
  schema,
  models,
  references,
  sourceVersion,
}: {
  styleId: string;
  styleName: string;
  schema: Record<string, unknown>;
  models: ModelCatalogEntry[];
  references: Reference[];
  sourceVersion: SourceVersion | null;
}) {
  const [prompt, setPrompt] = useState(sourceVersion?.prompt ?? "");
  const [selectedRefs, setSelectedRefs] = useState<string[]>(references.map((r) => r.id));
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyPreview, setReadyPreview] = useState<{ plan: ExecutionPlan; inputRevision: number } | null>(null);
  const { job, setJob } = useAiJob(null);
  const inputRevisionRef = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);

  const selectedModel = useMemo(() => models.find((m) => m.id === modelId), [models, modelId]);
  const operation = sourceVersion ? "image_to_image" as const : "text_to_image" as const;
  const refIds = selectedRefs;

  const invalidate = () => { inputRevisionRef.current += 1; setReadyPreview(null); };

  const toggleRef = useCallback((id: string) => {
    setSelectedRefs((prev) => prev.includes(id) ? prev.filter((refId) => refId !== id) : [...prev, id]);
    invalidate();
  }, []);

  const previewPlan = async () => {
    if (!prompt.trim() || !selectedModel || busyRef.current) return false;
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
        body: JSON.stringify({ operation, requestedModelId: modelId, styleId, sourceVersionId: sourceVersion?.id, prompt: prompt.trim(), costMode: "strict_style", count, size, quality, referenceIds: refIds, preserveRequestedModel: true }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(`${body.error?.code ?? "PLAN_FAILED"}: ${body.error?.message ?? "Unable to resolve execution plan"}`);
        return false;
      }
      if (!mountedRef.current || inputRevisionRef.current !== revision) return false;
      setReadyPreview({ plan: body.plan, inputRevision: revision });
      return true;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return false;
      if (!mountedRef.current) return false;
      setError("NETWORK_ERROR: Unable to resolve execution plan");
      return false;
    } finally {
      busyRef.current = false;
    }
  };

  const submit = async () => {
    if (!readyPreview || busyRef.current) return;
    if (readyPreview.inputRevision !== inputRevisionRef.current) { invalidate(); return; }
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
          referenceIds: refIds,
          sourceVersionId: sourceVersion?.id ?? undefined,
          size,
          quality,
          count,
          costMode: "strict_style",
          consent: { planHash: readyPreview.plan.planHash },
        }),
      });
      const jobBody = await jobRes.json().catch(() => ({}));
      if (jobRes.status === 409 && jobBody.error?.plan) {
        setError("Plan changed; please preview again");
        setReadyPreview(null);
        return;
      }
      if (!jobRes.ok) {
        setError(`${jobBody.error?.code ?? "SUBMIT_FAILED"}: ${jobBody.error?.message ?? "Unable to create image"}`);
        return;
      }
      const parsed = AiJobSchema.safeParse(jobBody.job);
      if (parsed.success) setJob(parsed.data);
      else setError("Invalid job response from server");
    } catch {
      setError("NETWORK_ERROR: Unable to create image");
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  };

  const terminal = job ? job.status === "succeeded" || job.status === "failed" || job.status === "canceled" : false;

  if (job) {
    if (job.status === "succeeded") {
      const results = Array.isArray(job.output?.results) ? job.output.results : [];
      const firstResult = results[0];
      const outputAssetId = firstResult && typeof firstResult === "object" && "asset_id" in firstResult && typeof firstResult.asset_id === "string" ? firstResult.asset_id : null;
      if (outputAssetId && typeof window !== "undefined") {
        window.location.assign(`/style/${styleId}/assets/${outputAssetId}`);
      }
    }
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--canvas)] text-[var(--text)]">
        <div className="text-center">
          {terminal ? (
            job.status === "succeeded" ? (
              <>
                <p className="text-sm text-[var(--muted)]">Đã tạo ảnh xong.</p>
                <a href={`/style/${styleId}`} className="mt-4 inline-block text-sm text-[var(--accent)] hover:underline">← Quay lại gallery</a>
              </>
            ) : (
              <>
                <p role="alert" className="text-sm text-[var(--danger)]">{job.error_message || `Tạo ảnh ${job.status === "canceled" ? "bị hủy" : "thất bại"}`}</p>
                <a href={`/style/${styleId}`} className="mt-4 inline-block text-sm text-[var(--accent)] hover:underline">← Quay lại gallery để thử lại</a>
              </>
            )
          ) : (
            <>
              <LoaderCircle className="mx-auto size-8 animate-spin text-[var(--accent)]" />
              <p className="mt-4 text-sm text-[var(--muted)]">Đang tạo ảnh…</p>
              <p className="mt-2 text-xs text-[var(--muted)]">Job {job.id.slice(0, 8)}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[var(--canvas)] text-[var(--text)]">
      <header className="flex h-14 items-center gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-4">
        <a href={`/style/${styleId}`} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">{styleName}</a>
        <span className="text-[var(--muted)]">/</span>
        <h1 className="font-semibold">Tạo ảnh mới</h1>
        {sourceVersion && <span className="ml-2 rounded-full bg-[var(--accent-subtle)] px-2 py-0.5 text-xs text-[var(--accent)]">Biến thể</span>}
      </header>
      <div className="mx-auto max-w-2xl space-y-6 p-5 sm:p-8">
        <div>
          <label className="studio-label">Model</label>
          <select className="studio-control w-full" value={modelId} onChange={(e) => { setModelId(e.target.value); invalidate(); const m = models.find((x) => x.id === e.target.value); if (m) { setSize(m.sizes[0]); setQuality(m.qualities[0]); } }}>
            <option value="" disabled>Chọn model</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div><label className="studio-label">Size</label><select className="studio-control w-full" value={size} onChange={(e) => { setSize(e.target.value); invalidate(); }}>{selectedModel?.sizes.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          <div><label className="studio-label">Quality</label><select className="studio-control w-full" value={quality} onChange={(e) => { setQuality(e.target.value); invalidate(); }}>{selectedModel?.qualities.map((q) => <option key={q} value={q}>{q}</option>)}</select></div>
          <div><label className="studio-label">Count</label><select className="studio-control w-full" value={count} onChange={(e) => { setCount(Number(e.target.value) as 1 | 2 | 3 | 4); invalidate(); }}>{[1, 2, 3, 4].filter((n) => n <= (selectedModel?.maxCount ?? 4)).map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
        </div>
        <div>
          <label className="studio-label">References ({selectedRefs.length}/{references.length})</label>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {references.map((ref) => <button key={ref.id} type="button" aria-pressed={selectedRefs.includes(ref.id)} onClick={() => toggleRef(ref.id)} className={`aspect-square rounded-lg border-2 transition ${selectedRefs.includes(ref.id) ? "border-[var(--accent)] bg-[var(--accent-subtle)]" : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]"}`}><span className="text-[10px] text-[var(--muted)]">{ref.id.slice(0, 8)}</span></button>)}
          </div>
        </div>
        <div>
          <label className="studio-label" htmlFor="style-generation-prompt">Prompt</label>
          <textarea id="style-generation-prompt" className="studio-control min-h-24 w-full" placeholder={operation === "image_to_image" ? "Mô tả nội dung cho biến thể…" : "Mô tả ảnh muốn tạo…"} value={prompt} onChange={(e) => { setPrompt(e.target.value); invalidate(); }} maxLength={8000} />
          <p className="mt-1 text-right text-xs text-[var(--muted)]">{prompt.length}/8000</p>
        </div>
        {readyPreview && <StylePlanPreview plan={readyPreview.plan} />}
        {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
        <button onClick={readyPreview ? submit : () => void previewPlan()} disabled={!prompt.trim() || !selectedModel || submitting || busyRef.current} className="studio-button-primary w-full">
          {busyRef.current ? <><LoaderCircle className="size-4 animate-spin" /> {readyPreview ? "Đang tạo…" : "Xem trước kế hoạch…"}</> : readyPreview ? "Tạo ảnh" : "Xem trước kế hoạch"}
        </button>
      </div>
    </div>
  );
}
