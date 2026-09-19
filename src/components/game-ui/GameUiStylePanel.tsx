"use client";

// The Game UI module index.  It mirrors the visual Style panel on purpose: same
// card, same plain-words setup state, same create path.  It differs in two ways
// that matter here - every card counts screens as well as references, and the
// whole list is loaded by the page (styles) instead of by this component, because
// the domain list has no API of its own and a Game UI style's screen count is only
// known from the domain query.

import { Image as ImageIcon, LayoutPanelTop, LoaderCircle, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { GameUiStyleSummary } from "@/lib/game-ui/service";
import type { StyleSetupState } from "@/lib/style/confirmed-definition";
import { formatDate } from "@/lib/format/datetime";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type LibraryItem = { id: string; name: string };

/** Plain words for the setup state - the list never shows raw grades or scores. */
const SETUP_STATUS: Record<StyleSetupState, string> = {
  references: "Needs reference images",
  analysis: "Needs analysis",
  review: "Ready to review",
  ready: "Confirmed and ready",
};

/** Radix Select and ToggleGroup reject empty values, so "No library" uses a sentinel. */
const NO_LIBRARY = "__none__";
const ALL_LIBRARIES = "__all__";

function setupStateOf(style: GameUiStyleSummary): StyleSetupState {
  return (style.setupState as StyleSetupState) in SETUP_STATUS
    ? (style.setupState as StyleSetupState)
    : style.status === "active"
      ? "ready"
      : "references";
}

/** `1 screen`, `2 screens`: the card counts are read at a glance and must not look wrong. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export default function GameUiStylePanel({
  initialStyles,
  libraries,
}: {
  initialStyles: GameUiStyleSummary[];
  libraries: LibraryItem[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "draft">("all");
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLibraryId, setNewLibraryId] = useState<string>(NO_LIBRARY);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const visibleStyles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return initialStyles.filter(
      (style) =>
        (activeLibraryId === null || style.libraryId === activeLibraryId) &&
        (statusFilter === "all" || style.status === statusFilter) &&
        style.name.toLowerCase().includes(needle),
    );
  }, [activeLibraryId, initialStyles, query, statusFilter]);

  const create = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/styles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, libraryId: newLibraryId === NO_LIBRARY ? null : newLibraryId, domain: "game_ui" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create the style"}`);
      const styleId = typeof body.style?.id === "string" ? body.style.id : null;
      setNewName("");
      setCreateOpen(false);
      // A new Game UI style has no references yet, so it opens on its first step.
      if (styleId) router.push(`/game-ui/${styleId}?tab=references`);
      else router.refresh();
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "Unable to create the style" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-foreground">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Game UI styles"
            aria-label="Search Game UI styles"
          />
        </div>
        <Select value={statusFilter} onValueChange={(next) => setStatusFilter(next as "all" | "active" | "draft")}>
          <SelectTrigger className="w-full sm:max-w-40" aria-label="Filter Game UI styles">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="draft">Drafts</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setCreateOpen(true)} className="shrink-0">
          <Plus className="size-4" aria-hidden /> New Game UI style
        </Button>
      </div>

      {libraries.length > 0 && (
        <ToggleGroup
          type="single"
          spacing={1}
          value={activeLibraryId ?? ALL_LIBRARIES}
          onValueChange={(next) => {
            if (next) setActiveLibraryId(next === ALL_LIBRARIES ? null : next);
          }}
          className="flex w-fit max-w-full justify-start overflow-x-auto"
        >
          <ToggleGroupItem value={ALL_LIBRARIES} className="min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
            All styles
          </ToggleGroupItem>
          {libraries.map((library) => (
            <ToggleGroupItem
              key={library.id}
              value={library.id}
              className="min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
            >
              {library.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      {feedback && (
        <Alert variant={feedback.kind === "error" ? "destructive" : "default"} role="alert" className="px-3 py-2">
          <AlertDescription className={feedback.kind === "error" ? "text-sm" : "text-sm text-success"}>{feedback.text}</AlertDescription>
        </Alert>
      )}

      {initialStyles.length === 0 ? (
        <Card className="items-center gap-3 p-8 text-center">
          <LayoutPanelTop className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No Game UI styles yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            A Game UI style starts with reference images: upload screenshots of your game&apos;s interface, analyze them into
            reusable rules, then generate screens from those rules.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> Create the first style
          </Button>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleStyles.map((style) => {
            const setupState = setupStateOf(style);
            return (
              <li key={style.id}>
                <Link href={`/game-ui/${style.id}`} className="group block h-full">
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
                      <p className="mt-auto text-xs text-muted-foreground">
                        {counted(style.referenceCount, "reference")} · {counted(style.screenCount, "screen")}
                      </p>
                      {formatDate(style.updatedAt) && <p className="text-xs text-muted-foreground">Updated {formatDate(style.updatedAt)}</p>}
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {initialStyles.length > 0 && visibleStyles.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No matching Game UI styles.</p>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setNewName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Game UI style</DialogTitle>
            <DialogDescription>
              Name the interface style you are describing. Reference images come next, and the style stays a draft until you
              confirm it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="game-ui-style-name" className="text-xs font-semibold">
                Style name
              </Label>
              <Input
                id="game-ui-style-name"
                value={newName}
                maxLength={100}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                }}
                placeholder="e.g. Neon battle HUD"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="game-ui-style-library" className="text-xs font-semibold">
                Library (optional)
              </Label>
              <Select value={newLibraryId} onValueChange={setNewLibraryId}>
                <SelectTrigger id="game-ui-style-library" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LIBRARY}>No library</SelectItem>
                  {libraries.map((library) => (
                    <SelectItem key={library.id} value={library.id}>
                      {library.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {feedback?.kind === "error" && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="text-xs">{feedback.text}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void create()} disabled={!newName.trim() || busy}>
              {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Create style
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
