"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/supabase/client";
import { AiJobSchema, ProjectJobFeedItemSchema, isTerminalStatus, type AiJob, type ProjectJobFeedItem } from "@/db/ai-jobs";

type ModuleScope = { module: "projects" | "style"; projectId?: string; styleId?: string };

function endpointFor(scope: ModuleScope) {
  return scope.module === "style" ? "/api/style/ai-jobs?limit=50" : `/api/projects/${scope.projectId}/ai-jobs?limit=50`;
}

function realtimeFilter(scope: ModuleScope) {
  return scope.module === "style" ? "module=eq.style" : `project_id=eq.${scope.projectId}`;
}

function channelName(scope: ModuleScope) {
  return scope.module === "style" ? "style-module-jobs" : `project-jobs-${scope.projectId}`;
}

export function mergeModuleJob(items: ProjectJobFeedItem[], job: AiJob) {
  const index = items.findIndex((item) => item.job.id === job.id);
  if (index === -1) return [...items, { job, result_urls: [] }];
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, job } : item);
}

export function useModuleJobs({ module: module_, projectId, styleId }: ModuleScope, initialItems: ProjectJobFeedItem[]) {
  const [items, setItems] = useState(initialItems);
  const terminalRefreshes = useRef(new Set<string>());
  const previousStatuses = useRef(new Map(initialItems.map((item) => [item.job.id, item.job.status])));
  const refresh = useCallback(async () => {
    const response = await fetch(endpointFor({ module: module_, projectId, styleId }), { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json();
    const parsed = ProjectJobFeedItemSchema.array().safeParse(body.jobs);
    if (parsed.success) setItems(parsed.data);
  }, [module_, projectId, styleId]);

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
    const channel = supabase.channel(channelName({ module: module_, projectId, styleId }))
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_jobs", filter: realtimeFilter({ module: module_, projectId, styleId }) }, (payload) => {
        const parsed = AiJobSchema.safeParse(payload.new);
        if (!parsed.success) return;
        const job = parsed.data;
        const previousStatus = previousStatuses.current.get(job.id);
        previousStatuses.current.set(job.id, job.status);
        setItems((current) => mergeModuleJob(current, job));
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
  }, [hasActiveJobs, module_, projectId, styleId, refresh]);

  const addJob = useCallback((job: AiJob) => {
    previousStatuses.current.set(job.id, job.status);
    setItems((current) => mergeModuleJob(current, job));
  }, []);

  return { items, addJob, refresh };
}
