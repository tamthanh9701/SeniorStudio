"use client";

import { AlertTriangle, Check, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import type { AiJob, AiJobStatus, ProjectJobFeedItem } from "@/db/ai-jobs";
import { JOB_STATUS_LABELS, jobErrorMessage } from "@/lib/ai/presentation";

const ACTIVE_STEPS: readonly AiJobStatus[] = ["queued", "submitting", "processing", "persisting", "succeeded"];

export default function JobTimeline({ items, onRetry, onCancel, onSelectResult }: {
  items: ProjectJobFeedItem[];
  onRetry: (job: AiJob) => void;
  onCancel: (job: AiJob) => void;
  onSelectResult: (result: { url: string; assetId?: string }) => void;
}) {
  return <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6">
    {items.map(({ job, result_urls }) => {
      const segments = job.status === "failed" || job.status === "canceled"
        ? [...ACTIVE_STEPS.slice(0, -1), job.status]
        : ACTIVE_STEPS;
      const currentIndex = segments.indexOf(job.status);
      const results = Array.isArray(job.output.results) ? job.output.results as Array<{ asset_id?: string }> : [];
      return <article key={job.id} className="space-y-4">
        <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-[#7c5cff] px-4 py-3 text-sm leading-6 text-white shadow-lg shadow-[#7c5cff]/10">
          <p className="whitespace-pre-wrap">{job.input.original_prompt ?? job.input.prompt}</p><time className="mt-2 block text-[11px] text-white/65">{new Date(job.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <div className="studio-card overflow-hidden" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3"><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${job.status === "succeeded" ? "bg-[#35c48d]" : job.status === "failed" ? "bg-[#ef6262]" : job.status === "canceled" ? "bg-[#98a2b3]" : "animate-pulse bg-[#7c5cff]"}`} /><strong className="text-sm">{JOB_STATUS_LABELS[job.status]}</strong></div><span className="text-xs text-[#667085]">{job.provider === "google" ? "Google AI Studio" : "OpenAI"} · {job.model}</span></div>
          <div className="p-4">
            <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }} aria-label={`Job progress: ${JOB_STATUS_LABELS[job.status]}`}>{segments.map((status, index) => <li key={status} className="min-w-0"><span className={`block h-1.5 rounded-full ${index <= currentIndex ? status === "failed" ? "bg-[#ef6262]" : status === "canceled" ? "bg-[#98a2b3]" : "bg-[#7c5cff]" : "bg-white/10"}`} /><span className="sr-only">{JOB_STATUS_LABELS[status]}</span></li>)}</ol>
            {!['succeeded','failed','canceled'].includes(job.status) && <p className="mt-4 flex items-center gap-2 text-sm text-[#98a2b3]"><LoaderCircle className="size-4 animate-spin" />{JOB_STATUS_LABELS[job.status]}</p>}
            {job.status === "succeeded" && result_urls.length > 0 && <div className={`mt-4 grid gap-3 ${result_urls.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>{result_urls.map((url, index) => <button key={url} onClick={() => onSelectResult({ url, assetId: results[index]?.asset_id })} className="group relative min-h-0 overflow-hidden rounded-xl border border-white/10 bg-black"><img src={url} alt={`Generated result ${index + 1}`} className="aspect-square h-full w-full object-cover transition group-hover:opacity-90" /><span className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-lg bg-black/60 text-white"><Check className="size-4" /></span></button>)}</div>}
            {job.status === "failed" && <FailedCard job={job} onRetry={onRetry} />}
            {job.status === "queued" && <button className="studio-button-secondary mt-4" onClick={() => onCancel(job)}><Square className="size-3.5" />Cancel</button>}
          </div>
        </div>
      </article>;
    })}
  </div>;
}

const CONFIRM_CODES = new Set(["VERSION_CONFLICT", "FILE_TOO_LARGE", "INVALID_REQUEST", "MALFORMED_PROVIDER_OUTPUT"]);

function FailedCard({ job, onRetry }: { job: AiJob; onRetry: (job: AiJob) => void }) {
  const [confirming, setConfirming] = useState(false);
  const needsConfirm = confirming && CONFIRM_CODES.has(job.error_code ?? "");
  return (
    <div role="alert" className="mt-4 rounded-xl border border-[#ef6262]/25 bg-[#ef6262]/10 p-3">
      <p className="flex gap-2 text-sm font-medium text-[#ff9b9b]"><AlertTriangle className="size-4 shrink-0" />{jobErrorMessage(job.error_code)}</p>
      {(job.error_code || job.error_message) && <p className="mt-1 text-xs text-[#667085]">{[job.error_code, job.error_message].filter(Boolean).join(" — ")}</p>}
      {needsConfirm ? (
        <div className="mt-3 flex items-center gap-2">
          <p className="text-xs text-[#d0d5dd]">Thử lại có thể tạo thêm ảnh mới với chi phí API. Tiếp tục?</p>
          <button className="studio-button-secondary" onClick={() => { setConfirming(false); onRetry(job); }}><RotateCcw className="size-4" />Try again</button>
          <button className="studio-button-secondary" onClick={() => setConfirming(false)}>Hủy</button>
        </div>
      ) : (
        <button className="studio-button-secondary mt-3" onClick={() => { if (CONFIRM_CODES.has(job.error_code ?? "")) setConfirming(true); else onRetry(job); }}><RotateCcw className="size-4" />Try again</button>
      )}
    </div>
  );
}
