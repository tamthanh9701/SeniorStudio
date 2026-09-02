"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/supabase/client";
import { AiJobSchema, ProjectJobFeedItemSchema, isTerminalStatus, type AiJob, type ProjectJobFeedItem } from "@/db/ai-jobs";

export function mergeProjectJob(items: ProjectJobFeedItem[], job: AiJob) {
  const index = items.findIndex((item) => item.job.id === job.id);
  if (index === -1) return [...items, { job, result_urls: [] }];
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, job } : item);
}

export function useProjectJobs(projectId: string, initialItems: ProjectJobFeedItem[]) {
  const [items, setItems] = useState(initialItems);
  const terminalRefreshes = useRef(new Set<string>());
  const previousStatuses = useRef(new Map(initialItems.map((item) => [item.job.id, item.job.status])));

  useEffect(() => {
    setItems(initialItems);
    previousStatuses.current = new Map(initialItems.map((item) => [item.job.id, item.job.status]));
    terminalRefreshes.current.clear();
  }, [initialItems, projectId]);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/ai-jobs?limit=50`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json();
    const parsed = ProjectJobFeedItemSchema.array().safeParse(body.jobs);
    if (parsed.success) setItems(parsed.data);
  }, [projectId]);

  const hasActiveJobs = useMemo(() => items.some((item) => !isTerminalStatus(item.job.status)), [items]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const supabase = createClient();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let subscribed = false;
    let closed = false;
    const startPolling = () => {
      if (closed || subscribed || pollTimer) return;
      void refresh();
      pollTimer = setInterval(refresh, 2000);
    };
    const channel = supabase.channel(`project-jobs-${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_jobs", filter: `project_id=eq.${projectId}` }, (payload) => {
        const parsed = AiJobSchema.safeParse(payload.new);
        if (!parsed.success) return;
        const job = parsed.data;
        const previousStatus = previousStatuses.current.get(job.id);
        previousStatuses.current.set(job.id, job.status);
        setItems((current) => mergeProjectJob(current, job));
        if (isTerminalStatus(job.status) && !isTerminalStatus(previousStatus ?? "queued") && !terminalRefreshes.current.has(job.id)) {
          terminalRefreshes.current.add(job.id);
          void refresh();
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          subscribed = true;
          clearInterval(pollTimer ?? undefined);
          pollTimer = null;
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          subscribed = false;
          startPolling();
        }
      });
    const realtimeTimeout = setTimeout(startPolling, 3000);
    return () => {
      closed = true;
      clearTimeout(realtimeTimeout);
      clearInterval(pollTimer ?? undefined);
      void supabase.removeChannel(channel);
    };
  }, [hasActiveJobs, projectId, refresh]);

  const addJob = useCallback((job: AiJob) => {
    previousStatuses.current.set(job.id, job.status);
    setItems((current) => mergeProjectJob(current, job));
  }, []);

  return { items, addJob, refresh };
}
