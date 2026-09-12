"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { LoaderCircle, Paintbrush, X } from "lucide-react";
import MaskEditor from "@/components/editor/MaskEditor";
import { INPAINT_MODELS } from "@/lib/ai/models";
import { AiJobSchema, isTerminalStatus, type SupportedModelId, type SupportedQuality } from "@/db/ai-jobs";
import type { ExecutionPlan } from "@/lib/ai/execution-plan";
import { StylePlanPreview } from "@/components/studio/StylePlanPreview";
import { StudioDialog } from "@/components/studio/StudioDialog";
import { useAiJob } from "@/lib/ai/use-ai-job";

type ReadyPreview = { plan: ExecutionPlan; maskId: string; inputRevision: number };

export default function StyleInpaintPage() {
  const params = useParams<{ styleId: string; assetId: string }>();
  const router = useRouter();
  const [version, setVersion] = useState<{ id: string; width: number; height: number } | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [styleName, setStyleName] = useState("");
  const [maskPng, setMaskPng] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const models = INPAINT_MODELS.filter((model) => model.operations.includes("inpaint"));
  const [modelId, setModelId] = useState<SupportedModelId>(models[0]?.id ?? "openai/gpt-image-2");
  const [maskId, setMaskId] = useState<string | null>(null);
  const selected = models.find((model) => model.id === modelId) ?? models[0];
  const [quality, setQuality] = useState<SupportedQuality>(selected?.qualities[0] ?? "auto");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyPreview, setReadyPreview] = useState<ReadyPreview | null>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);

  const { job, setJob, resultUrls } = useAiJob(null);
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
    if (!settingsOpen) return;
    settingsRef.current?.querySelector<HTMLElement>('select')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSettingsOpen(false); settingsTriggerRef.current?.focus(); return; }
      if (event.key !== "Tab") return;
      const root = settingsRef.current; if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settingsOpen]);

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
      })
      .catch(() => { if (mountedRef.current) setError("Failed to load asset"); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [params.assetId, params.styleId]);

  useEffect(() => {
    if (!job || !isTerminalStatus(job.status)) return;
    if (job.status === "succeeded") {
      const results = Array.isArray(job.output?.results) ? job.output.results : [];
      const firstResult = results[0];
      if (firstResult && typeof firstResult === "object" && "asset_id" in firstResult && typeof firstResult.asset_id === "string") {
        router.push(`/style/${params.styleId}/assets/${firstResult.asset_id}`);
        return;
      }
      setError("Job completed but no output result was produced");
    } else if (job.status === "failed") {
      setError(job.error_message || "Inpaint failed");
    }
  }, [job, params.styleId, router]);

  const preview = async () => {
    if (!maskPng || !version || !prompt.trim() || busyRef.current) return;
    const revision = inputRevisionRef.current;
    busyRef.current = true;
    setError(null);
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
      if (!mountedRef.current || inputRevisionRef.current !== revision) return;
      setMaskId(maskBody.maskId);
      const planRes = await fetch("/api/ai-execution-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "inpaint", requestedModelId: modelId, styleId: params.styleId, sourceAssetId: params.assetId, sourceVersionId: version.id, maskId: maskBody.maskId, prompt: prompt.trim(), quality, size: "auto", count: 1, referenceIds: [], preserveRequestedModel: true, useCurrentStyle: true }),
        signal: controller.signal,
      });
      const planBody = await planRes.json();
      if (!planRes.ok) throw new Error(`${planBody.error?.code ?? "PLAN_FAILED"}: ${planBody.error?.message ?? "Unable to resolve plan"}`);
      if (!mountedRef.current || inputRevisionRef.current !== revision) return;
      setReadyPreview({ plan: planBody.plan, maskId: maskBody.maskId, inputRevision: revision });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : "Unable to preview inpaint");
    } finally {
      busyRef.current = false;
    }
  };

  const submit = async () => {
    if (!maskPng || !version || !prompt.trim() || !readyPreview || busyRef.current) return;
    if (readyPreview.inputRevision !== inputRevisionRef.current) { invalidate(); return; }
    busyRef.current = true;
    setError(null);
    try {
      const jobRes = await fetch(`/api/assets/${params.assetId}/ai-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "inpaint", model: modelId, parentVersionId: version.id, maskId: readyPreview.maskId, prompt, quality, consent: { planHash: readyPreview.plan.planHash }, referenceIds: [], useCurrentStyle: true }),
      });
      const jobBody = await jobRes.json();
      if (jobRes.status === 409 && jobBody.error?.plan) {
        setError("Plan changed; please preview again");
        setReadyPreview(null);
        return;
      }
      if (!jobRes.ok) throw new Error(`${jobBody.error?.code ?? "SUBMIT_FAILED"}: ${jobBody.error?.message ?? "Enqueue failed"}`);
      const parsed = AiJobSchema.safeParse(jobBody.job);
      if (parsed.success) setJob(parsed.data);
      else setError("Invalid job response from server");
    } catch (caught) {
      if (caught instanceof Error) setError(caught.message);
    } finally {
      busyRef.current = false;
    }
  };

  const terminal = job ? isTerminalStatus(job.status) : false;

  if (loading) return <div className="flex min-h-dvh items-center justify-center bg-[var(--canvas)]"><LoaderCircle className="size-6 animate-spin text-[var(--accent)]" /></div>;
  if (!version || !signedUrl) return <div className="flex min-h-dvh items-center justify-center bg-[var(--canvas)] text-[var(--muted)]">Asset not found</div>;

  return (
    <div className="h-dvh overflow-hidden bg-[var(--canvas)] text-[var(--text)]">
      <header className="flex h-14 items-center gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-4">
        <a href={`/style/${params.styleId}/assets/${params.assetId}`} className="truncate text-sm text-[var(--muted)] hover:text-[var(--text)]">
          {styleName}
        </a>
        <span className="text-[var(--muted)]">/</span>
        <h1 className="flex items-center gap-2 font-semibold">
          <Paintbrush className="size-4 text-[var(--accent)]" />
          Inpaint
        </h1>
        <button ref={settingsTriggerRef} type="button" onClick={() => setSettingsOpen(true)} className="studio-button-secondary ml-auto xl:hidden" aria-label="Open inpaint settings">Settings</button>
      </header>

      <div className="flex h-[calc(100dvh-3.5rem)]">
        <div className="flex flex-1 flex-col min-w-0">
          <div className="flex-1 min-h-0">
            <MaskEditor
              imageUrl={signedUrl}
              width={version.width}
              height={version.height}
              onMaskChange={(png) => { setMaskPng(png); setReadyPreview(null); }}
              onDirty={() => { invalidate(); setMaskPng(null); setMaskId(null); }}
            />
          </div>
          <div className="border-t border-[var(--border)] bg-[var(--panel)] p-3">
            <button
              onClick={readyPreview ? submit : preview}
              disabled={!maskPng || !prompt.trim() || submitting || (job !== null && !terminal) || busyRef.current}
              className="studio-button-primary w-full"
            >
              {busyRef.current ? <><LoaderCircle className="size-4 animate-spin" /> {readyPreview ? "Enqueuing…" : "Preparing plan…"}</> : job !== null && !terminal ? <><LoaderCircle className="size-4 animate-spin" /> Processing…</> : readyPreview ? "Confirm and apply inpaint" : "Preview inpaint plan"}
            </button>
          </div>
        </div>

        <aside className="hidden w-64 shrink-0 border-l border-[var(--border)] bg-[var(--panel)] p-4 xl:block">
          <div className="flex items-center gap-2">
            <Paintbrush className="size-4 text-[var(--accent)]" />
            <h2 className="font-semibold">Inpaint Settings</h2>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">Vẽ vùng mask rồi nhập prompt chỉnh sửa. Kết quả sẽ tạo ảnh mới trong group.</p>
          <div className="mt-6 space-y-4">
            <label>
              <span className="studio-label">Model</span>
              <select className="studio-control" value={modelId} onChange={(event) => { const next = models.find((m) => m.id === event.target.value); if (!next) return; setModelId(next.id); setQuality(next.qualities[0]); invalidate(); setMaskId(null); }}>
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </label>
            <label>
              <span className="studio-label">Quality</span>
              <select className="studio-control" value={quality} onChange={(event) => { setQuality(event.target.value as SupportedQuality); invalidate(); }}>
                {selected?.qualities.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
            </label>
            <label>
              <span className="studio-label">Prompt</span>
              <textarea className="studio-control min-h-20 w-full" placeholder="Mô tả chỉnh sửa cho vùng mask" value={prompt} onChange={(event) => { setPrompt(event.target.value); invalidate(); }} maxLength={8000} />
            </label>
          </div>
          {readyPreview && <StylePlanPreview plan={readyPreview.plan} />}
          {error && <p role="alert" className="mt-4 text-xs text-[var(--danger)]">{error}</p>}
        </aside>
      </div>
      <StudioDialog open={settingsOpen} onClose={() => { setSettingsOpen(false); settingsTriggerRef.current?.focus(); }} label="Inpaint settings" initialFocusRef={settingsRef} dismissible className="studio-card w-full max-w-md p-6" style={{ position: "fixed" } as React.CSSProperties}>
      <div ref={settingsRef as React.RefObject<HTMLDivElement>}>
        <div className="flex items-center gap-2"><Paintbrush className="size-4 text-[var(--accent)]" /><h2 className="font-semibold">Inpaint Settings</h2></div>
        <p className="mt-2 text-xs text-[var(--muted)]">Vẽ vùng mask rồi nhập prompt chỉnh sửa. Kết quả sẽ tạo ảnh mới trong group.</p>
        <div className="mt-6 space-y-4">
          <label><span className="studio-label">Model</span><select className="studio-control" value={modelId} onChange={(event) => { const next = models.find((m) => m.id === event.target.value); if (!next) return; setModelId(next.id); setQuality(next.qualities[0]); invalidate(); setMaskId(null); }}>{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
          <label><span className="studio-label">Quality</span><select className="studio-control" value={quality} onChange={(event) => { setQuality(event.target.value as SupportedQuality); invalidate(); }}>{selected?.qualities.map((q) => <option key={q} value={q}>{q}</option>)}</select></label>
          <label><span className="studio-label">Prompt</span><textarea className="studio-control min-h-20 w-full" placeholder="Mô tả chỉnh sửa cho vùng mask" value={prompt} onChange={(event) => { setPrompt(event.target.value); invalidate(); }} maxLength={8000} /></label>
        </div>
        {error && <p role="alert" className="mt-4 text-xs text-[var(--danger)]">{error}</p>}
      </div>
      </StudioDialog>
    </div>
  );
}
