"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/supabase/client";
import { AiJobSchema, isTerminalStatus, type AiJob } from "@/db/ai-jobs";

export function useAiJob(initialJob: AiJob | null) {
  const [job, setJob] = useState<AiJob | null>(initialJob);
  const [resultUrls, setResultUrls] = useState<string[]>([]);


  useEffect(() => {
    if (!job || isTerminalStatus(job.status)) return;
    const supabase = createClient();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const fetchJob = async () => {
      const response = await fetch(`/api/ai-jobs/${job.id}`, { cache: "no-store" });
      if (!response.ok || closed) return;
      const body = await response.json();
      const parsed = AiJobSchema.safeParse(body.job);
      if (parsed.success) setJob(parsed.data);
      setResultUrls(body.result_urls ?? []);
    };
    const startPolling = () => {
      if (pollTimer) return;
      void fetchJob();
      pollTimer = setInterval(fetchJob, 2000);
    };
    const channel = supabase.channel(`ai-job-${job.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "ai_jobs", filter: `id=eq.${job.id}` }, (payload) => {
        const parsed = AiJobSchema.safeParse(payload.new);
        if (parsed.success) {
          setJob(parsed.data);
          if (isTerminalStatus(parsed.data.status)) void fetchJob();
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") startPolling();
      });
    const realtimeTimeout = setTimeout(startPolling, 3000);
    return () => {
      closed = true;
      clearTimeout(realtimeTimeout);
      if (pollTimer) clearInterval(pollTimer);
      void supabase.removeChannel(channel);
    };
  }, [job]);

  return { job, setJob, resultUrls };
}
