"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/supabase/client";
import { AiJobSchema, ProjectJobFeedItemSchema, isTerminalStatus, type AiJob, type ProjectJobFeedItem } from "@/db/ai-jobs";

type StyleScope = { module: "style"; styleId: string };
type ProjectScope = { module: "projects"; projectId: string };
type ModuleScope = StyleScope | ProjectScope;

function endpointFor(scope: ModuleScope) {
  if (scope.module === "style") return `/api/styles/${scope.styleId}/ai-jobs?limit=50`;
  return `/api/projects/${scope.projectId}/ai-jobs?limit=50`;
}

function realtimeFilter(scope: ModuleScope) {
  if (scope.module === "style") return `style_id=eq.${scope.styleId}`;
  return `project_id=eq.${scope.projectId}`;
}

function channelName(scope: ModuleScope) {
  if (scope.module === "style") return `style-group-${scope.styleId}`;
  return `project-jobs-${scope.projectId}`;
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

export function useModuleJobs(scope: ModuleScope, initialItems: ProjectJobFeedItem[]) {
  const scopeKey = scope.module === "style" ? scope.styleId : scope.projectId;
  const [items, setItems] = useState(() => reconcileJobFeed([], initialItems));
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "offline">("idle");
  const terminalRefreshes = useRef(new Set<string>());
  const previousStatuses = useRef(new Map(initialItems.map((item) => [item.job.id, item.job.status])));
  const refreshSequence = useRef(0);
  useEffect(() => {
    refreshSequence.current += 1;
    terminalRefreshes.current = new Set();
    previousStatuses.current = new Map();
    setItems(reconcileJobFeed([], initialItems));
  }, [scopeKey]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const sequence = ++refreshSequence.current;
    setSyncState("syncing");
    try {
      const response = await fetch(endpointFor(scope), { cache: "no-store" });
      if (!response.ok || sequence !== refreshSequence.current) { setSyncState("offline"); return false; }
      const body = await response.json();
      if (sequence !== refreshSequence.current) return false;
      const parsed = ProjectJobFeedItemSchema.array().safeParse(body.jobs);
      if (!parsed.success) { setSyncState("offline"); return false; }
      setItems((current) => reconcileJobFeed(current, parsed.data));
      setSyncState("idle");
      return true;
    } catch { setSyncState("offline"); return false; }
  }, [scopeKey]);

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
    const channel = supabase.channel(channelName(scope))
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_jobs", filter: realtimeFilter(scope) }, (payload) => {
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
  }, [hasActiveJobs, hasUnhydratedJobs, scopeKey, refresh]);

  const addJob = useCallback((job: AiJob) => {
    previousStatuses.current.set(job.id, job.status);
    setItems((current) => mergeModuleJob(current, job));
  }, []);
  return { items, addJob, refresh, syncState };
}
