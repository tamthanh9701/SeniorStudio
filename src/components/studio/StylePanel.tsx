"use client";

import { LoaderCircle, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { StyleSetupState } from "@/lib/style/confirmed-definition";

type LibraryItem = { id: string; name: string; sort_order: number };
type StyleListItem = {
  id: string;
  name: string;
  status: string;
  referenceCount: number;
  libraryId: string | null;
  setupState?: StyleSetupState;
};

/** Plain words for the setup state — the list never shows raw grades or scores. */
const SETUP_STATUS: Record<StyleSetupState, string> = {
  references: "Needs reference images",
  analysis: "Needs analysis",
  review: "Ready to review",
  ready: "Confirmed and ready",
};

function setupStateOf(style: StyleListItem): StyleSetupState {
  return style.setupState ?? (style.status === "active" ? "ready" : "references");
}

export default function StylePanel() {
  const router = useRouter();
  const [styles, setStyles] = useState<StyleListItem[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const [libraries, setLibraries] = useState<LibraryItem[]>([]);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null); // null = All
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "draft">("all");
  const [stylesLoading, setStylesLoading] = useState(true);

  const loadStyles = useCallback(async (libraryId: string | null = null) => {
    setStylesLoading(true);
    try {
      const query = libraryId === null ? "" : `?libraryId=${libraryId}`;
      const response = await fetch(`/api/styles${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load style groups");
      const body = await response.json();
      setStyles(Array.isArray(body.styles) ? body.styles : []);
    } catch {
      setFeedback({ kind: "error", text: "Unable to load style groups. Try again." });
    } finally {
      setStylesLoading(false);
    }
  }, []);

  const loadLibraries = useCallback(async () => {
    const response = await fetch("/api/styles/libraries", { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json();
    setLibraries(Array.isArray(body.libraries) ? body.libraries : []);
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void loadStyles(activeLibraryId); }, 0); return () => window.clearTimeout(timer); }, [loadStyles, activeLibraryId]);
  useEffect(() => { const timer = window.setTimeout(() => { void loadLibraries(); }, 0); return () => window.clearTimeout(timer); }, [loadLibraries]);

  const create = async () => {
    const name = newName.trim();
    if (!name || busy !== null) return;
    setBusy("create");
    setFeedback(null);
    try {
      const response = await fetch("/api/styles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, libraryId: activeLibraryId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create style"}`);
      const styleId = typeof body.style?.id === "string" ? body.style.id : null;
      setNewName("");
      // The new style has no references yet, so setup starts on the references screen.
      if (styleId) router.push(`/style/${styleId}?tab=references`);
      else await loadStyles(activeLibraryId);
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "Unable to create style" });
    } finally {
      setBusy(null);
    }
  };

  const visibleStyles = styles.filter(
    (style) => (statusFilter === "all" || style.status === statusFilter) && style.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return <div className="space-y-4 text-[var(--text)]">
    <div className="flex flex-col gap-3 sm:flex-row">
      <input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="Name your style group" aria-label="New style name" className="studio-control min-w-0 flex-1" />
      <button onClick={() => void create()} disabled={!newName.trim() || busy !== null} aria-label="Create style" className="studio-button-primary shrink-0">
        {busy === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />} Create style
      </button>
    </div>
    {feedback && <p role="alert" className={`text-sm ${feedback.kind === "error" ? "text-[var(--danger)]" : "text-[var(--success)]"}`}>{feedback.text}</p>}
    <div className="flex flex-col gap-3 sm:flex-row">
      <input className="studio-control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search style groups" aria-label="Search style groups" />
      <select className="studio-control sm:max-w-40" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "draft")} aria-label="Filter style groups">
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="draft">Drafts</option>
      </select>
    </div>
    {libraries.length > 0 && <div className="flex gap-1 overflow-x-auto pb-2">
      <button onClick={() => setActiveLibraryId(null)} aria-pressed={activeLibraryId === null} className={`min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium transition-colors ${activeLibraryId === null ? "bg-[var(--accent-subtle)] text-[var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`}>All libraries</button>
      {libraries.map((library) => <button key={library.id} onClick={() => setActiveLibraryId(library.id)} aria-pressed={activeLibraryId === library.id} className={`min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium transition-colors ${activeLibraryId === library.id ? "bg-[var(--accent-subtle)] text-[var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`}>{library.name}</button>)}
    </div>}
    {stylesLoading && styles.length === 0 && <div aria-hidden className="space-y-2"><div className="h-16 animate-pulse rounded-xl bg-[var(--surface-hover)]" /><div className="h-16 animate-pulse rounded-xl bg-[var(--surface-hover)]" /><div className="h-16 animate-pulse rounded-xl bg-[var(--surface-hover)]" /></div>}
    {!stylesLoading && visibleStyles.length === 0 && <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">No matching style groups.</p>}
    <ul className="space-y-3">
      {visibleStyles.map((style) => {
        const setupState = setupStateOf(style);
        const ready = setupState === "ready";
        return <li key={style.id} className="studio-card flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 font-medium">
              <span aria-hidden className={style.status === "active" ? "text-[var(--success)]" : "text-[var(--muted)]"}>{style.status === "active" ? "●" : "○"}</span>
              <span className="truncate">{style.name}</span>
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">{SETUP_STATUS[setupState]} · {style.referenceCount}/8 reference images</p>
          </div>
          <Link href={`/style/${style.id}?tab=${ready ? "images" : "references"}`} className={`${ready ? "studio-button-secondary" : "studio-button-primary"} shrink-0`}>
            {ready ? "Open style" : "Continue setup"}
          </Link>
        </li>;
      })}
    </ul>
  </div>;
}
