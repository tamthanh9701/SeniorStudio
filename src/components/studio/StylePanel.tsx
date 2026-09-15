"use client";

import { LoaderCircle, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { StyleSetupState } from "@/lib/style/confirmed-definition";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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

/** Radix Select and ToggleGroup reject empty values, so "All libraries" uses a sentinel. */
const ALL_LIBRARIES = "__all__";

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

  return <div className="space-y-4 text-foreground">
    <div className="flex flex-col gap-3 sm:flex-row">
      <Input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="Name your style group" aria-label="New style name" className="min-w-0 flex-1" />
      <Button onClick={() => void create()} disabled={!newName.trim() || busy !== null} aria-label="Create style" className="shrink-0">
        {busy === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />} Create style
      </Button>
    </div>
    {feedback && <Alert variant={feedback.kind === "error" ? "destructive" : "default"} role="alert" className="px-3 py-2"><AlertDescription className={feedback.kind === "error" ? "text-sm" : "text-sm text-success"}>{feedback.text}</AlertDescription></Alert>}
    <div className="flex flex-col gap-3 sm:flex-row">
      <Input className="min-w-0 flex-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search style groups" aria-label="Search style groups" />
      <Select value={statusFilter} onValueChange={(next) => setStatusFilter(next as "all" | "active" | "draft")}>
        <SelectTrigger className="w-full sm:max-w-40" aria-label="Filter style groups"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="draft">Drafts</SelectItem>
        </SelectContent>
      </Select>
    </div>
    {libraries.length > 0 && <ToggleGroup
      type="single"
      spacing={1}
      value={activeLibraryId ?? ALL_LIBRARIES}
      onValueChange={(next) => { if (next) setActiveLibraryId(next === ALL_LIBRARIES ? null : next); }}
      className="flex w-fit max-w-full justify-start overflow-x-auto pb-2"
    >
      <ToggleGroupItem value={ALL_LIBRARIES} className="min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary/10 data-[state=on]:text-primary">All libraries</ToggleGroupItem>
      {libraries.map((library) => <ToggleGroupItem key={library.id} value={library.id} className="min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary/10 data-[state=on]:text-primary">{library.name}</ToggleGroupItem>)}
    </ToggleGroup>}
    {stylesLoading && styles.length === 0 && <div aria-hidden className="space-y-2"><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div>}
    {!stylesLoading && visibleStyles.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No matching style groups.</p>}
    <ul className="space-y-3">
      {visibleStyles.map((style) => {
        const setupState = setupStateOf(style);
        const ready = setupState === "ready";
        return <li key={style.id}>
          <Card className="flex-row flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium">
                <span aria-hidden className={style.status === "active" ? "text-success" : "text-muted-foreground"}>{style.status === "active" ? "●" : "○"}</span>
                <span className="truncate">{style.name}</span>
              </p>
              <Badge variant="secondary" className="mt-2">{SETUP_STATUS[setupState]} · {style.referenceCount}/8 reference images</Badge>
            </div>
            <Button asChild variant={ready ? "outline" : "default"} className="shrink-0">
              <Link href={`/style/${style.id}?tab=${ready ? "images" : "references"}`}>{ready ? "Open style" : "Continue setup"}</Link>
            </Button>
          </Card>
        </li>;
      })}
    </ul>
  </div>;
}
