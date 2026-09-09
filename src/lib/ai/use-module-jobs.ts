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
const STATUS_ORDER: Record<AiJob["status"], number> = { queued: 0, submitting: 1, processing: 2, persisting: 3, succeeded: 4, failed: 4, canceled: 4 };

function compareJobs(a: AiJob, b: AiJob) {
  const timestamp = Date.parse(a.updated_at) - Date.parse(b.updated_at);
  return timestamp || STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
}

function sortFeedItems(a: ProjectJobFeedItem, b: ProjectJobFeedItem) {
  return Date.parse(a.job.created_at) - Date.parse(b.job.created_at) || a.job.id.localeCompare(b.job.id);
}

function preferJob(current: AiJob, incoming: AiJob) {
  if (isTerminalStatus(current.status) && !isTerminalStatus(incoming.status)) return current;
  if (isTerminalStatus(incoming.status) && !isTerminalStatus(current.status)) return incoming;
  return compareJobs(incoming, current) >= 0 ? incoming : current;
}

function resultVersionIds(job: AiJob): string[] {
  const results = Array.isArray(job.output.results) ? (job.output.results as Array<{ version_id?: unknown }>) : [];
  return results.map((result) => result.version_id).filter((value): value is string => typeof value === "string");
}

function preferUrls(current: ProjectJobFeedItem, incoming: ProjectJobFeedItem): string[] {
  if (preferJob(current.job, incoming.job) !== incoming.job) return current.result_urls;
  if (JSON.stringify(resultVersionIds(current.job)) !== JSON.stringify(resultVersionIds(incoming.job))) return incoming.result_urls;
  return incoming.result_urls.length > 0 ? incoming.result_urls : current.result_urls;
}

export function reconcileJobFeed(current: ProjectJobFeedItem[], snapshot: ProjectJobFeedItem[]) {
  const byId = new Map<string, ProjectJobFeedItem>();
  for (const item of current) byId.set(item.job.id, item);
  for (const item of snapshot) {
    const existing = byId.get(item.job.id);
    if (!existing) { byId.set(item.job.id, item); continue; }
    const jobWinner = preferJob(existing.job, item.job) === item.job ? item.job : existing.job;
    const urls = preferUrls(existing, item);
    byId.set(item.job.id, { job: jobWinner, result_urls: urls });
  }
  const merged = [...byId.values()];
  const terminalIds = new Set(merged.filter((item) => isTerminalStatus(item.job.status))
    .sort((a, b) => compareJobs(b.job, a.job) || b.job.id.localeCompare(a.job.id))
    .slice(0, 50).map((item) => item.job.id));
  return merged.filter((item) => !isTerminalStatus(item.job.status) || terminalIds.has(item.job.id)).sort(sortFeedItems);
}

export function mergeModuleJob(items: ProjectJobFeedItem[], job: AiJob) {
  const existing = items.find((item) => item.job.id === job.id);
  return reconcileJobFeed(items, [{ job, result_urls: existing?.result_urls ?? [] }]);
}

export function useModuleJobs({ module: module_, projectId, styleId }: ModuleScope, initialItems: ProjectJobFeedItem[]) {
  const [items, setItems] = useState(() => reconcileJobFeed([], initialItems));
  const terminalRefreshes = useRef(new Set<string>());
  const previousStatuses = useRef(new Map(initialItems.map((item) => [item.job.id, item.job.status])));
  const refreshSequence = useRef(0);
  const refresh = useCallback(async (): Promise<boolean> => {
    const sequence = ++refreshSequence.current;
    const response = await fetch(endpointFor({ module: module_, projectId, styleId }), { cache: "no-store" });
    if (!response.ok || sequence !== refreshSequence.current) return false;
    const body = await response.json();
    if (sequence !== refreshSequence.current) return false;
    const parsed = ProjectJobFeedItemSchema.array().safeParse(body.jobs);
    if (!parsed.success) return false;
    setItems((current) => reconcileJobFeed(current, parsed.data));
    return true;
  }, [module_, projectId, styleId]);

  const hasActiveJobs = useMemo(() => items.some((item) => !isTerminalStatus(item.job.status)), [items]);
  const hasUnhydratedJobs = useMemo(
    () => items.some(({ job, result_urls }) => job.status === "succeeded" && result_urls.length === 0 && resultVersionIds(job).length > 0),
    [items],
  );

  useEffect(() => {
    if (!hasActiveJobs && !hasUnhydratedJobs) return;
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
          void refresh().then((refreshed) => {
            if (refreshed) terminalRefreshes.current.add(job.id);
          }).catch(() => {});
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
  }, [hasActiveJobs, hasUnhydratedJobs, module_, projectId, styleId, refresh]);

  const addJob = useCallback((job: AiJob) => {
    previousStatuses.current.set(job.id, job.status);
    setItems((current) => mergeModuleJob(current, job));
  }, []);

  return { items, addJob, refresh };
}
