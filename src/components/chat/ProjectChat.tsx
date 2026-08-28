"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import type { BrowserBridgeWorker, BrowserJob, BrowserOperation, ChatMessage, ChatThread } from "@/db/browser-bridge";
import { ACTIVE_JOB_STATUSES, RETRYABLE_JOB_STATUSES } from "@/db/browser-bridge";

type ThreadPayload = { thread: ChatThread; messages: ChatMessage[]; active_job: BrowserJob | null; bridge: BrowserBridgeWorker };

export function ProjectChat({ projectId, initialThreadId = null }: { projectId: string; initialThreadId?: string | null }) {
  const router = useRouter();
  const [threadId, setThreadId] = useState(initialThreadId);
  const [mode, setMode] = useState<BrowserOperation>("chat");
  const [message, setMessage] = useState("");
  const [parentVersionId, setParentVersionId] = useState("");
  const [payload, setPayload] = useState<ThreadPayload | null>(null);
  const [lastJob, setLastJob] = useState<BrowserJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function loadThread(id: string) {
    const response = await fetch(`/api/projects/${projectId}/chat/threads/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error ?? "LOAD_FAILED");
    const next = await response.json() as ThreadPayload;
    setPayload(next);
    if (lastJob && next.messages.some((candidate) => candidate.job_id === lastJob.id && candidate.kind === "image")) router.refresh();
    if (next.active_job) setLastJob(next.active_job);
    return next;
  }

  useEffect(() => {
    if (!threadId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await loadThread(threadId);
        if (!stopped && next.active_job && ACTIVE_JOB_STATUSES.includes(next.active_job.status)) timer = setTimeout(poll, 2000);
      } catch (nextError) {
        if (!stopped) setError(nextError instanceof Error ? nextError.message : "LOAD_FAILED");
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [threadId]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    const response = await fetch(`/api/projects/${projectId}/chat/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: threadId ?? undefined, mode, message, parentVersionId: mode === "edit" ? parentVersionId : undefined }),
    });
    const body = await response.json();
    setSubmitting(false);
    if (!response.ok) { setError(body.error ?? "ENQUEUE_FAILED"); return; }
    setThreadId(body.thread.id); setLastJob(body.job); setMessage("");
    setPayload((current) => ({ thread: body.thread, messages: [...(current?.messages ?? []), body.message], active_job: body.job, bridge: current?.bridge ?? { worker_id: "unavailable", status: "offline", last_seen_at: "", active_job_id: null, browser_url: null, error_code: null, error_message: null } }));
  }

  async function retry() {
    if (!lastJob) return;
    const response = await fetch(`/api/browser-jobs/${lastJob.id}/retry`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "RETRY_FAILED"); return; }
    setLastJob(body.job); if (threadId) await loadThread(threadId);
  }

  const shownJob = payload?.active_job ?? lastJob;
  return <section className="mb-10 rounded-xl border p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Project chat</h2><p className="text-sm text-gray-500">ChatGPT Web browser bridge</p></div>
      <span className="rounded-full border px-3 py-1 text-sm">Bridge: {payload?.bridge.status ?? "offline"}</span>
    </div>
    <div className="mt-4 max-h-96 space-y-3 overflow-y-auto rounded-lg bg-gray-50 p-4">
      {(payload?.messages ?? []).length === 0 && <p className="text-sm text-gray-500">Start a chat or generate the first project image.</p>}
      {(payload?.messages ?? []).map((item) => <div key={item.id} className={item.role === "user" ? "text-right" : "text-left"}>
        <div className="inline-block max-w-[85%] rounded-lg border bg-white px-3 py-2 text-sm whitespace-pre-wrap">{item.content}</div>
        {item.kind === "image" && item.asset_id && <div><Link className="text-sm text-blue-600 hover:underline" href={`/projects/${projectId}/assets/${item.asset_id}`}>Open resulting asset</Link></div>}
      </div>)}
    </div>
    {shownJob && <div className="mt-3 flex items-center gap-3 text-sm"><span>Job: {shownJob.status}</span>{shownJob.error_code && <span className="text-red-600">{shownJob.error_code}</span>}{RETRYABLE_JOB_STATUSES.includes(shownJob.status) && <button className="text-blue-600 hover:underline" onClick={retry}>Retry</button>}</div>}
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">{(["chat", "generate", "edit"] as BrowserOperation[]).map((value) => <button type="button" key={value} onClick={() => setMode(value)} className={`rounded-md border px-3 py-2 text-sm ${mode === value ? "bg-black text-white" : "bg-white"}`}>{value === "chat" ? "Chat" : value === "generate" ? "Generate image" : "Edit selected image"}</button>)}</div>
      {mode === "edit" && <input className="w-full rounded-md border p-2" required placeholder="Selected parent version ID" value={parentVersionId} onChange={(event) => setParentVersionId(event.target.value)} />}
      <textarea className="min-h-24 w-full rounded-md border p-3" required maxLength={8000} placeholder={mode === "chat" ? "Message ChatGPT" : mode === "generate" ? "Describe the image" : "Describe the edit"} value={message} onChange={(event) => setMessage(event.target.value)} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={submitting || Boolean(payload?.active_job)} className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{submitting ? "Sending…" : "Send"}</button>
    </form>
  </section>;
}
