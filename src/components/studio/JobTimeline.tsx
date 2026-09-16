"use client";

import { AlertTriangle, Check, LoaderCircle, RotateCcw, Square } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { AiJob, AiJobStatus, ProjectJobFeedItem } from "@/db/ai-jobs";
import { JOB_STATUS_LABELS, jobErrorMessage } from "@/lib/ai/presentation";
import { formatDate, formatTime, vnDayKey, TIME_ZONE_LABEL } from "@/lib/format/datetime";

const ACTIVE_STEPS: readonly AiJobStatus[] = ["queued", "submitting", "processing", "persisting", "succeeded"];
const TERMINAL_STATUSES: readonly AiJobStatus[] = ["succeeded", "failed", "canceled"];

const STATUS_BADGE_VARIANT: Record<AiJobStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "default",
  submitting: "default",
  processing: "default",
  persisting: "default",
  succeeded: "secondary",
  failed: "destructive",
  canceled: "outline",
};

const STATUS_DOT_CLASS: Record<AiJobStatus, string> = {
  queued: "animate-pulse bg-primary",
  submitting: "animate-pulse bg-primary",
  processing: "animate-pulse bg-primary",
  persisting: "animate-pulse bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  canceled: "bg-muted-foreground",
};

export default function JobTimeline({ items, onRetry, onCancel, onSelectResult }: {
  items: ProjectJobFeedItem[];
  onRetry: (job: AiJob) => void;
  onCancel: (job: AiJob) => void;
  onSelectResult: (result: { url: string; assetId?: string }) => void;
}) {
  // Resolved after mount so the server and the client agree on "today" before
  // the first paint; until then the bands show the date alone.
  const [todayKey, setTodayKey] = useState<string | null>(null);
  useEffect(() => setTodayKey(vnDayKey(Date.now())), []);

  // Jobs arrive newest first, so consecutive equal day keys are one band.
  const days = useMemo(() => {
    const groups: Array<{ key: string; createdAt: string; succeeded: number; failed: number; running: number; items: ProjectJobFeedItem[] }> = [];
    for (const item of items) {
      const key = vnDayKey(item.job.created_at) ?? "unknown";
      let group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        group = { key, createdAt: item.job.created_at, succeeded: 0, failed: 0, running: 0, items: [] };
        groups.push(group);
      }
      if (item.job.status === "succeeded") group.succeeded += 1;
      else if (item.job.status === "failed" || item.job.status === "canceled") group.failed += 1;
      else group.running += 1;
      group.items.push(item);
    }
    return groups;
  }, [items]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6">
      {days.map((day) => (
        <section key={day.key} className="space-y-8" aria-label={formatDate(day.createdAt) ?? day.key}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground">
              {day.key === todayKey ? `Hôm nay · ${formatDate(day.createdAt)}` : formatDate(day.createdAt)}
              <span className="ml-2 font-normal">{TIME_ZONE_LABEL}</span>
            </p>
            <p className="text-xs text-muted-foreground">{day.succeeded} done · {day.failed} failed · {day.running} running</p>
          </div>
          {day.items.map(({ job, result_urls }) => {
        const running = !TERMINAL_STATUSES.includes(job.status);
        const stepIndex = ACTIVE_STEPS.indexOf(job.status);
        const progress = stepIndex < 0 ? 0 : Math.round(((stepIndex + 1) / ACTIVE_STEPS.length) * 100);
        const results = Array.isArray(job.output.results) ? job.output.results as Array<{ asset_id?: string }> : [];
        return (
          <article key={job.id} className="space-y-4">
            <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-lg shadow-blue-500/10">
              <p className="whitespace-pre-wrap">{job.input.original_prompt ?? job.input.prompt}</p>
              <time className="mt-2 block text-[11px] text-white/65">{formatTime(job.created_at)}</time>
            </div>
            <Card className="gap-0 overflow-hidden p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <Badge variant={STATUS_BADGE_VARIANT[job.status]} className="gap-2">
                  <span aria-hidden className={cn("size-2 rounded-full", STATUS_DOT_CLASS[job.status])} />
                  {JOB_STATUS_LABELS[job.status]}
                </Badge>
                <span className="text-xs text-muted-foreground">{job.provider === "google" ? "Google AI Studio" : "OpenAI"} · {job.model}</span>
              </div>
              <CardContent className="p-4">
                {running && <Progress value={progress} aria-label={`Job progress: ${JOB_STATUS_LABELS[job.status]}`} />}
                {running && (
                  <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" />
                    {JOB_STATUS_LABELS[job.status]}
                  </p>
                )}
                {job.status === "succeeded" && result_urls.length > 0 && (
                  <div className={cn("mt-4 grid gap-3", result_urls.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
                    {result_urls.map((url, index) => (
                      <button key={url} aria-label={`Open generated result ${index + 1}`} onClick={() => onSelectResult({ url, assetId: results[index]?.asset_id })} className="group relative min-h-0 overflow-hidden rounded-xl border border-border bg-black">
                        <Image src={url} alt={`Generated result ${index + 1}`} width={512} height={512} sizes={result_urls.length > 1 ? "(min-width:640px) 320px, 45vw" : "(min-width:768px) 640px, 90vw"} className="aspect-square h-full w-full object-cover transition group-hover:opacity-90" />
                        <span className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-lg bg-black/60 text-white">
                          <Check className="size-4" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {job.status === "failed" && <FailedCard job={job} onRetry={onRetry} />}
                {job.status === "queued" && (
                  <Button variant="outline" className="mt-4" onClick={() => onCancel(job)}>
                    <Square className="size-3.5" />
                    Cancel
                  </Button>
                )}
              </CardContent>
            </Card>
          </article>
        );
      })}
        </section>
      ))}
    </div>
  );
}

const CONFIRM_CODES: Record<string, true> = {
  VERSION_CONFLICT: true,
  FILE_TOO_LARGE: true,
  INVALID_REQUEST: true,
  MALFORMED_PROVIDER_OUTPUT: true,
};

function FailedCard({ job, onRetry }: { job: AiJob; onRetry: (job: AiJob) => void }) {
  const [confirming, setConfirming] = useState(false);
  const needsConfirm = confirming && CONFIRM_CODES[job.error_code ?? ""] === true;
  return (
    <Alert variant="destructive" role="alert" className="mt-4">
      <AlertTriangle />
      <AlertTitle>{jobErrorMessage(job.error_code)}</AlertTitle>
      {(job.error_code || job.error_message) && (
        <AlertDescription>{[job.error_code, job.error_message].filter(Boolean).join(" — ")}</AlertDescription>
      )}
      {needsConfirm ? (
        <div className="col-start-2 mt-3 flex flex-wrap items-center gap-2">
          <p className="text-xs text-foreground">Retrying may create new images with additional API costs. Continue?</p>
          <Button variant="outline" onClick={() => { setConfirming(false); onRetry(job); }}>
            <RotateCcw className="size-4" />
            Try again
          </Button>
          <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      ) : (
        <Button
          variant="outline"
          className="col-start-2 mt-3 justify-self-start"
          onClick={() => { if (CONFIRM_CODES[job.error_code ?? ""] === true) setConfirming(true); else onRetry(job); }}
        >
          <RotateCcw className="size-4" />
          Try again
        </Button>
      )}
    </Alert>
  );
}
