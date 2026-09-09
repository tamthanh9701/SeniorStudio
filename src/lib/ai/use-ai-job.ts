"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/supabase/client";
import { AiJobSchema, isTerminalStatus, type AiJob } from "@/db/ai-jobs";

const STATUS_ORDER: Record<AiJob["status"], number> = { queued: 0, submitting: 1, processing: 2, persisting: 3, succeeded: 4, failed: 4, canceled: 4 };
function newerJob(current: AiJob | null, incoming: AiJob) {
  if (!current || current.id !== incoming.id) return incoming;
  if (isTerminalStatus(current.status) && !isTerminalStatus(incoming.status)) return current;
  const time = Date.parse(incoming.updated_at) - Date.parse(current.updated_at);
  return time > 0 || (time === 0 && STATUS_ORDER[incoming.status] >= STATUS_ORDER[current.status]) ? incoming : current;
}

export function useAiJob(initialJob: AiJob | null) {
  const [job, setJob] = useState<AiJob | null>(initialJob);
  const [resultUrls, setResultUrls] = useState<string[]>([]);
  const latestJobId = useRef(initialJob?.id);
  const fetchedTerminal = useRef<string | null>(null);
  useEffect(() => { latestJobId.current = job?.id; }, [job?.id]);
  const jobId = job?.id;
  const terminal = isTerminalStatus(job?.status ?? "queued");
  useEffect(() => {
    if (!jobId) return;
    const supabase = createClient();
    let closed = false;
    const fetchJob = async () => {
      const response = await fetch(`/api/ai-jobs/${jobId}`, { cache: "no-store" });
      if (!response.ok || closed || latestJobId.current !== jobId) return;
      const body = await response.json();
      if (closed || latestJobId.current !== jobId) return;
      const parsed = AiJobSchema.safeParse(body.job);
      if (parsed.success) setJob((current) => newerJob(current, parsed.data));
      if (Array.isArray(body.result_urls) && latestJobId.current === jobId) setResultUrls(body.result_urls);
      fetchedTerminal.current = jobId;
    };
    if (terminal) { if (fetchedTerminal.current !== jobId) void fetchJob(); return () => { closed = true; }; }
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => { if (!closed && !pollTimer) { void fetchJob(); pollTimer = setInterval(() => void fetchJob(), 2000); } };
    const channel = supabase.channel(`ai-job-${jobId}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "ai_jobs", filter: `id=eq.${jobId}` }, (payload) => { const parsed = AiJobSchema.safeParse(payload.new); if (!parsed.success) return; setJob((current) => newerJob(current, parsed.data)); if (isTerminalStatus(parsed.data.status)) void fetchJob(); }).subscribe((status) => { if (status !== "SUBSCRIBED") startPolling(); });
    const realtimeTimeout = setTimeout(startPolling, 3000);
    return () => { closed = true; clearTimeout(realtimeTimeout); clearInterval(pollTimer ?? undefined); void supabase.removeChannel(channel); };
  }, [jobId, terminal]);
  return { job, setJob, resultUrls };
}
