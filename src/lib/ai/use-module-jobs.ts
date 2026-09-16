"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiJobSchema, ProjectJobFeedItemSchema, isTerminalStatus, type AiJob, type ProjectJobFeedItem } from "@/db/ai-jobs";

type StyleScope = { module: "style"; styleId: string };
type ProjectScope = { module: "projects"; projectId: string };
type ModuleScope = StyleScope | ProjectScope;

function endpointFor(moduleName: ModuleScope["module"], id: string) {
  if (moduleName === "style") return `/api/styles/${id}/ai-jobs?limit=50`;
  return `/api/projects/${id}/ai-jobs?limit=50`;
}


const STATUS_ORDER: Record<AiJob["status"], number> = { queued: 0, submitting: 1, processing: 2, persisting: 3, succeeded: 4, failed: 4, canceled: 4 };
const POLL_INTERVAL_MS = 2000;

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
  const moduleName = scope.module;
  const scopeId = moduleName === "style" ? scope.styleId : scope.projectId;
  const scopeKey = `${moduleName}:${scopeId}`;
  const endpoint = useMemo(() => endpointFor(moduleName, scopeId), [moduleName, scopeId]);
  const [items, setItems] = useState(() => reconcileJobFeed([], initialItems));
  const [loadedScope, setLoadedScope] = useState(scopeKey);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "offline">("idle");
  const terminalRefreshes = useRef(new Set<string>());
  const previousStatuses = useRef(new Map(initialItems.map((item) => [item.job.id, item.job.status])));
  const refreshSequence = useRef(0);
  // Adjusting during render keeps the new scope's snapshot in the same commit; an
  // effect would paint the previous scope's jobs first.
  if (loadedScope !== scopeKey) {
    setLoadedScope(scopeKey);
    setItems(reconcileJobFeed([], initialItems));
  }
  useEffect(() => {
    refreshSequence.current += 1;
    terminalRefreshes.current = new Set();
    previousStatuses.current = new Map();
  }, [scopeKey]);

  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> => {
    const sequence = ++refreshSequence.current;
    // The poll is invisible: a fetch that succeeds a moment later would flash the
    // "Syncing job status…" notice on every tick.
    if (!quiet) setSyncState("syncing");
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      // Superseded by a newer request: its data is no newer, and that is not a failure.
      if (sequence !== refreshSequence.current) return false;
      if (!response.ok) { setSyncState("offline"); return false; }
      const body = await response.json();
      if (sequence !== refreshSequence.current) return false;
      const parsed = ProjectJobFeedItemSchema.array().safeParse(body.jobs);
      if (!parsed.success) { setSyncState("offline"); return false; }
      setItems((current) => reconcileJobFeed(current, parsed.data));
      setSyncState("idle");
      return true;
    } catch { setSyncState("offline"); return false; }
  }, [endpoint]);

  const hasActiveJobs = useMemo(() => items.some((item) => !isTerminalStatus(item.job.status)), [items]);
  const hasUnhydratedJobs = useMemo(
    () => items.some(({ job, result_urls }) => job.status === "succeeded" && result_urls.length === 0 && resultVersionIds(job).length > 0),
    [items],
  );

  useEffect(() => {
    if (!hasActiveJobs && !hasUnhydratedJobs) return;
    // Polling is the delivery mechanism.  Realtime was tried here and removed: a
    // change reaches a subscriber only when its role may read the row, this client
    // is cookie-authenticated, and the workspace policy hides every ai_jobs row, so
    // the channel reported SUBSCRIBED while never delivering an event - one idle
    // socket per open tab.
    // The next poll waits for this one to settle.  A fixed interval overlaps itself on a
    // slow server (2.4-2.9s here), and a superseded response is discarded, so the feed
    // would never advance on exactly the deployments that need it most.
    let pollTimer: number | null = null;
    let closed = false;
    const poll = async () => {
      const startedAt = Date.now();
      // A hidden tab keeps its schedule but skips the request: nobody is looking
      // at the feed, and the first visible poll catches up immediately.
      if (typeof document === "undefined" || !document.hidden) await refresh({ quiet: true });
      if (closed) return;
      // Keep the intended cadence when the server answers slower than it, but never let two
      // requests overlap: a superseded response is discarded, so overlapping polls would
      // leave a slow deployment updating nothing at all.
      pollTimer = window.setTimeout(() => { void poll(); }, Math.max(500, POLL_INTERVAL_MS - (Date.now() - startedAt)));
    };
    pollTimer = window.setTimeout(() => { void poll(); }, 0);
    return () => {
      closed = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [hasActiveJobs, hasUnhydratedJobs, scopeKey, refresh]);

  const addJob = useCallback((job: AiJob) => {
    previousStatuses.current.set(job.id, job.status);
    setItems((current) => mergeModuleJob(current, job));
  }, []);
  return { items, addJob, refresh, syncState };
}
