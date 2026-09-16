"use client";

import { Image as ImageIcon, LoaderCircle, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StyleSetupState } from "@/lib/style/confirmed-definition";
import { formatDate } from "@/lib/format/datetime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type LibraryItem = { id: string; name: string; sort_order: number };
type StyleListItem = {
  id: string;
  name: string;
  status: string;
  referenceCount: number;
  imageCount: number;
  thumbnailUrl: string | null;
  updatedAt: string;
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

/** `1 image`, `2 images`: the card counts are read at a glance and must not look wrong. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export default function StylePanel({ notice }: { notice?: string | null } = {}) {
  // Held in state: the URL is cleaned immediately after mount, and the message
  // must survive that navigation.
  const [noticeText] = useState(notice ?? null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryName, setLibraryName] = useState("");
  const [libraryError, setLibraryError] = useState<string | null>(null);
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
  const stylesRequestRef = useRef(0);

  const loadStyles = useCallback(async (libraryId: string | null = null) => {
    // Tab switches fire overlapping requests; only the newest may publish its
    // list or clear the loading flag, otherwise an old response wins.
    const request = (stylesRequestRef.current += 1);
    setStylesLoading(true);
    try {
      const query = libraryId === null ? "" : `?libraryId=${libraryId}`;
      const response = await fetch(`/api/styles${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load style groups");
      const body = await response.json();
      if (request !== stylesRequestRef.current) return;
      setStyles(Array.isArray(body.styles) ? body.styles : []);
    } catch {
      if (request !== stylesRequestRef.current) return;
      setFeedback({ kind: "error", text: "Unable to load style groups. Try again." });
    } finally {
      if (request === stylesRequestRef.current) setStylesLoading(false);
    }
  }, []);

  const createLibrary = async () => {
    const name = libraryName.trim();
    if (!name || busy !== null) return;
    setBusy("library");
    setLibraryError(null);
    try {
      const response = await fetch("/api/styles/libraries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create the library"}`);
      setLibraryName("");
      setLibraryOpen(false);
      await loadLibraries();
      setFeedback({ kind: "success", text: `Library “${name}” created. Assign styles to it from a style's settings.` });
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Unable to create the library");
    } finally {
      setBusy(null);
    }
  };

  const loadLibraries = useCallback(async () => {
    const response = await fetch("/api/styles/libraries", { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json();
    setLibraries(Array.isArray(body.libraries) ? body.libraries : []);
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void loadStyles(activeLibraryId); }, 0); return () => window.clearTimeout(timer); }, [loadStyles, activeLibraryId]);
  useEffect(() => { const timer = window.setTimeout(() => { void loadLibraries(); }, 0); return () => window.clearTimeout(timer); }, [loadLibraries]);
  // The notice arrives once from the deleted style's workspace; a reload should
  // not repeat a deletion that already happened.
  useEffect(() => { if (notice) router.replace("/style"); }, [notice, router]);

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
    {noticeText && <Alert variant="default" role="status" className="px-3 py-2"><AlertDescription className="text-sm text-success">{noticeText}</AlertDescription></Alert>}
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
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
      type="single"
      spacing={1}
      value={activeLibraryId ?? ALL_LIBRARIES}
      onValueChange={(next) => { if (next) setActiveLibraryId(next === ALL_LIBRARIES ? null : next); }}
      className="flex w-fit max-w-full justify-start overflow-x-auto"
    >
      <ToggleGroupItem value={ALL_LIBRARIES} className="min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary/10 data-[state=on]:text-primary">All styles</ToggleGroupItem>
      {libraries.map((library) => <ToggleGroupItem key={library.id} value={library.id} className="min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary/10 data-[state=on]:text-primary">{library.name}</ToggleGroupItem>)}
      </ToggleGroup>
      <Button type="button" variant="outline" size="sm" onClick={() => setLibraryOpen(true)}>
        <Plus className="size-3.5" aria-hidden /> New library
      </Button>
    </div>
    <Dialog open={libraryOpen} onOpenChange={(open) => { setLibraryOpen(open); if (!open) { setLibraryName(""); setLibraryError(null); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New library</DialogTitle>
          <DialogDescription>Libraries group styles so a long list stays navigable. You can assign a style to one from its settings.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="library-name" className="text-xs font-semibold">Library name</Label>
          <Input
            id="library-name"
            value={libraryName}
            maxLength={100}
            onChange={(event) => setLibraryName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void createLibrary(); }}
            placeholder="e.g. Client work, Illustration sets"
          />
        </div>
        {libraryError && <Alert variant="destructive"><AlertDescription>{libraryError}</AlertDescription></Alert>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setLibraryOpen(false)} disabled={busy !== null}>Cancel</Button>
          <Button type="button" onClick={() => void createLibrary()} disabled={!libraryName.trim() || busy !== null}>
            {busy === "library" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Create library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {stylesLoading && styles.length === 0 && <div aria-hidden className="space-y-2"><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div>}
    {!stylesLoading && visibleStyles.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No matching style groups.</p>}
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {visibleStyles.map((style) => {
        const setupState = setupStateOf(style);
        return <li key={style.id}>
          <Link href={`/style/${style.id}`} className="group block h-full">
            <Card className="h-full gap-0 overflow-hidden p-0 transition-colors group-hover:border-primary/50">
              {style.thumbnailUrl ? (
                <Image
                  src={style.thumbnailUrl}
                  alt={style.name}
                  width={480}
                  height={360}
                  sizes="(min-width:1280px) 24vw, (min-width:640px) 45vw, 92vw"
                  className="h-40 w-full object-cover"
                />
              ) : (
                <div aria-hidden className="flex h-40 w-full items-center justify-center bg-accent">
                  <ImageIcon className="size-6 text-muted-foreground" />
                </div>
              )}
              <div className="flex flex-1 flex-col gap-2 p-4">
                <p className="truncate font-medium">{style.name}</p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={style.status === "active" ? "default" : "secondary"}>{style.status === "active" ? "Active" : "Draft"}</Badge>
                  <Badge variant="secondary">{SETUP_STATUS[setupState]}</Badge>
                </div>
                <p className="mt-auto text-xs text-muted-foreground">{counted(style.imageCount, "image")} · {counted(style.referenceCount, "reference")}</p>
                {formatDate(style.updatedAt) && <p className="text-xs text-muted-foreground">Updated {formatDate(style.updatedAt)}</p>}
              </div>
            </Card>
          </Link>
        </li>;
      })}
    </ul>
  </div>;
}
