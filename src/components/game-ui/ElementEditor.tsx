"use client";

// Element map editing for one generated screen, plus the render workspace that
// hosts it.  Geometry is stored in source-image pixels and only converted to
// display pixels at render time: a box dragged on a 400 px preview must still
// describe the same pixels of a 1536 px image, or every export would crop the
// wrong region.

import { AlertTriangle, LoaderCircle, Plus, RefreshCw, Trash2, Wand2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import ElementAssetDialog from "@/components/game-ui/ElementAssetDialog";
import AssetPackExport from "@/components/game-ui/AssetPackExport";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { boundsContain, elementGraphProblems, parseElementDocument, type CoverageEntry, type ElementBounds, type ElementDocument, type GameUiElement, type ScreenSpec } from "@/lib/game-ui/contracts";
import type { GameUiOutputView, GameUiRenderSummary } from "@/lib/game-ui/service";
import { ELEMENT_KINDS, KIND_DESCRIPTIONS, kindLabel } from "@/lib/game-ui/taxonomy";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import { cn } from "@/lib/utils";

type Handle = "move" | "nw" | "ne" | "sw" | "se";
type Drag = { elementId: string; handle: Handle; startX: number; startY: number; bounds: ElementBounds; scale: number };

const HANDLES: readonly Handle[] = ["nw", "ne", "sw", "se"];

/** jsdom predates crypto.randomUUID; a v4-shaped id keeps the document valid there. */
function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const digits = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  digits[12] = "4";
  digits[16] = ((Number.parseInt(digits[16], 16) & 0x3) | 0x8).toString(16);
  const joined = digits.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function withElement(document: ElementDocument, elementId: string, patch: Partial<GameUiElement>): ElementDocument {
  return { ...document, elements: document.elements.map((element) => (element.id === elementId ? { ...element, ...patch } : element)) };
}

/**
 * Keeps a box inside the canvas, inside its parent and around its own children.
 * A parent that no longer contains a child would be rejected on save, and moving a
 * bar would silently leave its track behind.
 */
function constrain(bounds: ElementBounds, element: { parent_id: string | null; id?: string }, document: ElementDocument): ElementBounds {
  const parent = element.parent_id ? document.elements.find((entry) => entry.id === element.parent_id) : undefined;
  const children = element.id ? document.elements.filter((entry) => entry.parent_id === element.id) : [];
  const left = Math.max(0, parent ? parent.bounds.x : 0);
  const top = Math.max(0, parent ? parent.bounds.y : 0);
  const right = Math.min(document.canvas.width, parent ? parent.bounds.x + parent.bounds.width : document.canvas.width);
  const bottom = Math.min(document.canvas.height, parent ? parent.bounds.y + parent.bounds.height : document.canvas.height);
  // Only an element that has children is stretched to cover them.  The previous
  // form defaulted these to the container's own edges, which turned every edit of
  // a child into "resize to the parent's box".
  const extent = children.length > 0
    ? {
        left: Math.min(...children.map((child) => child.bounds.x)),
        top: Math.min(...children.map((child) => child.bounds.y)),
        right: Math.max(...children.map((child) => child.bounds.x + child.bounds.width)),
        bottom: Math.max(...children.map((child) => child.bounds.y + child.bounds.height)),
      }
    : null;

  const width = Math.min(Math.max(bounds.width, extent ? extent.right - extent.left : 1), right - left);
  const height = Math.min(Math.max(bounds.height, extent ? extent.bottom - extent.top : 1), bottom - top);
  let x = Math.min(Math.max(bounds.x, left), right - width);
  let y = Math.min(Math.max(bounds.y, top), bottom - height);
  if (extent) {
    // A parent stays over its children, and inside its own container.
    x = Math.max(left, Math.min(x, extent.left));
    y = Math.max(top, Math.min(y, extent.top));
  }
  return { x, y, width, height };
}

/** Numeric boxes are the keyboard-reachable equivalent of dragging. */
function BoundsField({ id, label, value, min, max, onChange }: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      <Input
        id={id}
        type="number"
        className="h-9"
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
      />
    </div>
  );
}

function statusTone(status: CoverageEntry["status"]): string {
  if (status === "present") return "text-success";
  if (status === "missing") return "text-destructive";
  return "text-warning";
}

export default function ElementEditor({
  imageUrl,
  width,
  height,
  document,
  onChange,
  requirements = [],
}: {
  imageUrl: string;
  width: number;
  height: number;
  document: ElementDocument;
  onChange: (next: ElementDocument) => void;
  /** Requirement names for the coverage checklist; ids are shown when omitted. */
  requirements?: readonly { id: string; name: string; required: boolean }[];
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(document.elements[0]?.id ?? null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const selected = document.elements.find((element) => element.id === selectedId) ?? null;
  const problems = elementGraphProblems(document);
  const requirementName = (requirementId: string) => requirements.find((entry) => entry.id === requirementId)?.name ?? requirementId;

  const beginDrag = (event: React.PointerEvent<HTMLElement>, element: GameUiElement, handle: Handle) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    // Without a measured canvas the pointer delta cannot be scaled; falling back to
    // 1 keeps the box in source pixels rather than in some half-measured space.
    const scale = rect && rect.width > 0 ? rect.width / width : 1;
    dragRef.current = { elementId: element.id, handle, startX: event.clientX, startY: event.clientY, bounds: { ...element.bounds }, scale };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is an optimization */ }
    }
    setSelectedId(element.id);
    event.stopPropagation();
  };

  const drag = (event: React.PointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active) return;
    const element = document.elements.find((entry) => entry.id === active.elementId);
    if (!element) return;
    const dx = Math.round((event.clientX - active.startX) / active.scale);
    const dy = Math.round((event.clientY - active.startY) / active.scale);
    const start = active.bounds;
    const next: ElementBounds = active.handle === "move"
      ? { ...start, x: start.x + dx, y: start.y + dy }
      : {
          x: active.handle === "nw" || active.handle === "sw" ? start.x + dx : start.x,
          y: active.handle === "nw" || active.handle === "ne" ? start.y + dy : start.y,
          width: active.handle === "nw" || active.handle === "sw" ? start.width - dx : start.width + dx,
          height: active.handle === "nw" || active.handle === "ne" ? start.height - dy : start.height + dy,
        };
    onChange(withElement(document, element.id, { bounds: constrain(next, element, document) }));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const addElement = () => {
    const boxWidth = Math.min(240, Math.max(16, Math.round(width / 4)));
    const boxHeight = Math.min(120, Math.max(16, Math.round(height / 8)));
    const element: GameUiElement = {
      id: newId(),
      parent_id: null,
      kind: "button",
      custom_type: null,
      name: `Element ${document.elements.length + 1}`,
      purpose: "",
      visible_text: null,
      visible_state: null,
      bounds: constrain({ x: Math.round((width - boxWidth) / 2), y: Math.round((height - boxHeight) / 2), width: boxWidth, height: boxHeight }, { parent_id: null }, document),
      z_index: document.elements.reduce((highest, entry) => Math.max(highest, entry.z_index), -1) + 1,
      occluded: false,
      confidence: null,
      notes: "",
      reviewed: false,
    };
    onChange({ ...document, elements: [...document.elements, element] });
    setSelectedId(element.id);
  };

  /** Reparenting keeps the subtree; deleting a parent without one is a separate choice. */
  const deleteElement = (target: GameUiElement, mode: "reparent" | "subtree") => {
    const children = document.elements.filter((element) => element.parent_id === target.id);
    if (mode === "subtree") {
      const doomed = new Set([target.id, ...children.map((child) => child.id)]);
      onChange({
        ...document,
        elements: document.elements.filter((element) => !doomed.has(element.id)),
        coverage: document.coverage.map((entry) => ({ ...entry, element_ids: entry.element_ids.filter((id) => !doomed.has(id)) })),
      });
    } else {
      onChange({
        ...document,
        elements: document.elements
          .filter((element) => element.id !== target.id)
          .map((element) => (element.parent_id === target.id ? { ...element, parent_id: target.parent_id } : element)),
        coverage: document.coverage.map((entry) => ({ ...entry, element_ids: entry.element_ids.filter((id) => id !== target.id) })),
      });
    }
    setDeleteTargetId(null);
    setSelectedId(null);
  };

  /** Raises or lowers a box past its nearest neighbour in the z order. */
  const reorder = (element: GameUiElement, direction: "up" | "down") => {
    const others = document.elements.filter((entry) => entry.id !== element.id);
    const candidate = others
      .filter((entry) => (direction === "up" ? entry.z_index > element.z_index : entry.z_index < element.z_index))
      .sort((a, b) => (direction === "up" ? a.z_index - b.z_index : b.z_index - a.z_index))[0];
    if (!candidate) return;
    onChange({
      ...document,
      elements: document.elements.map((entry) => {
        if (entry.id === element.id) return { ...entry, z_index: candidate.z_index };
        if (entry.id === candidate.id) return { ...entry, z_index: element.z_index };
        return entry;
      }),
    });
  };

  const updateCoverage = (requirementId: string, patch: Partial<CoverageEntry>) => {
    const exists = document.coverage.some((entry) => entry.requirement_id === requirementId);
    const coverage = exists
      ? document.coverage.map((entry) => (entry.requirement_id === requirementId ? { ...entry, ...patch } : entry))
      : [...document.coverage, { requirement_id: requirementId, element_ids: [], status: "uncertain" as const, note: "", ...patch }];
    onChange({ ...document, coverage });
  };

  const unchecked = requirements.filter((requirement) => !document.coverage.some((entry) => entry.requirement_id === requirement.id));
  const missingRequired = document.coverage.filter((entry) => entry.status === "missing" && requirements.find((requirement) => requirement.id === entry.requirement_id)?.required !== false);

  return (
    <div className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-3">
        <div
          ref={canvasRef}
          className="relative w-full overflow-hidden rounded-lg border border-border bg-accent"
          style={{ aspectRatio: `${width} / ${height}` }}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <Image src={imageUrl} alt="Generated screen" fill sizes="(min-width:1280px) 60vw, 92vw" className="object-contain" />
          {document.elements.map((element) => {
            const isSelected = element.id === selectedId;
            return (
              <div
                key={element.id}
                role="button"
                tabIndex={0}
                aria-label={`${element.name}, ${kindLabel(element.kind, element.custom_type)}`}
                aria-pressed={isSelected}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedId(element.id);
                  }
                }}
                onPointerDown={(event) => beginDrag(event, element, "move")}
                className={cn(
                  "absolute cursor-move border-2 text-left",
                  isSelected ? "border-primary" : element.reviewed ? "border-success/70" : "border-warning/80",
                )}
                style={{
                  left: `${(element.bounds.x / width) * 100}%`,
                  top: `${(element.bounds.y / height) * 100}%`,
                  width: `${(element.bounds.width / width) * 100}%`,
                  height: `${(element.bounds.height / height) * 100}%`,
                }}
              >
                <span className="pointer-events-none absolute -top-5 left-0 max-w-full truncate rounded bg-background/90 px-1 text-[10px] text-foreground">{element.name}</span>
                {isSelected && HANDLES.map((handle) => (
                  <span
                    key={handle}
                    role="presentation"
                    onPointerDown={(event) => beginDrag(event, element, handle)}
                    className={cn(
                      "absolute size-3 rounded-sm border border-background bg-primary",
                      handle === "nw" && "-left-1.5 -top-1.5 cursor-nwse-resize",
                      handle === "ne" && "-right-1.5 -top-1.5 cursor-nesw-resize",
                      handle === "sw" && "-left-1.5 -bottom-1.5 cursor-nesw-resize",
                      handle === "se" && "-right-1.5 -bottom-1.5 cursor-nwse-resize",
                    )}
                  />
                ))}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Boxes are stored in source pixels ({width}×{height}); the canvas scales them for display only.
        </p>

        {problems.length > 0 && (
          <Alert variant="destructive" role="alert" className="px-3 py-2">
            <AlertDescription>
              <span className="text-xs font-medium">This map cannot be saved yet</span>
              <ul className="mt-1 space-y-1 text-xs">
                {problems.map((problem) => <li key={problem}>{problem}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <Card className="gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Elements</h3>
            <Button type="button" variant="outline" size="sm" onClick={addElement} disabled={document.elements.length >= 100}>
              <Plus className="size-4" aria-hidden /> Add element
            </Button>
          </div>
          {document.elements.length === 0 ? (
            <p role="status" className="text-xs text-muted-foreground">No elements yet. Detect them from the image or add them by hand.</p>
          ) : (
            <ul className="space-y-1">
              {document.elements.map((element) => (
                <li key={element.id}>
                  <button
                    type="button"
                    aria-current={element.id === selectedId ? "true" : undefined}
                    onClick={() => setSelectedId(element.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm",
                      element.id === selectedId ? "bg-primary/10 text-primary" : "hover:bg-accent",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{element.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{kindLabel(element.kind, element.custom_type)}</span>
                    {element.reviewed && <Badge variant="secondary">Reviewed</Badge>}
                    {element.occluded && <Badge variant="secondary">Occluded</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Coverage checklist</h3>
            {missingRequired.length > 0 && <span className="text-xs text-destructive">{missingRequired.length} required element(s) missing</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            Coverage is the analysis&apos; own evidence, not a guarantee: mark each requirement yourself before trusting the export.
          </p>
          {document.coverage.length === 0 && unchecked.length === 0 ? (
            <p role="status" className="text-xs text-muted-foreground">This screen has no requirements to check.</p>
          ) : (
            <ul className="space-y-2">
              {document.coverage.map((entry) => (
                <li key={entry.requirement_id} className="space-y-1 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{requirementName(entry.requirement_id)}</span>
                    <span className={cn("text-xs font-medium", statusTone(entry.status))}>{entry.status}</span>
                    <Select value={entry.status} onValueChange={(value) => updateCoverage(entry.requirement_id, { status: value as CoverageEntry["status"] })}>
                      <SelectTrigger className="w-32" aria-label={`Coverage status for ${requirementName(entry.requirement_id)}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="present">Present</SelectItem>
                        <SelectItem value="missing">Missing</SelectItem>
                        <SelectItem value="uncertain">Uncertain</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Input
                    aria-label={`Coverage note for ${requirementName(entry.requirement_id)}`}
                    placeholder="What you checked"
                    value={entry.note}
                    maxLength={500}
                    onChange={(event) => updateCoverage(entry.requirement_id, { note: event.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {entry.element_ids.length === 0
                      ? "No element is linked to this requirement."
                      : `Linked: ${entry.element_ids.map((id) => document.elements.find((element) => element.id === id)?.name ?? id).join(", ")}`}
                  </p>
                </li>
              ))}
              {unchecked.map((requirement) => (
                <li key={requirement.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{requirement.name}</span>
                  <span className="text-xs text-muted-foreground">Not checked</span>
                  <Button type="button" variant="outline" size="xs" onClick={() => updateCoverage(requirement.id, { status: "uncertain", note: "" })}>
                    Check this requirement
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-3">
        <Card className="gap-3 p-4">
          <h3 className="text-sm font-semibold">Inspector</h3>
          {!selected ? (
            <p role="status" className="text-xs text-muted-foreground">Select an element on the image or in the list.</p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="element-kind" className="text-xs font-medium text-muted-foreground">Kind</Label>
                <Select value={selected.kind} onValueChange={(value) => onChange(withElement(document, selected.id, { kind: value as GameUiElement["kind"], custom_type: value === "custom" ? selected.custom_type ?? "" : null }))}>
                  <SelectTrigger id="element-kind" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{ELEMENT_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{KIND_DESCRIPTIONS[selected.kind]}</p>
              </div>
              {selected.kind === "custom" && (
                <div className="space-y-1">
                  <Label htmlFor="element-custom-type" className="text-xs font-medium text-muted-foreground">Custom type</Label>
                  <Input id="element-custom-type" value={selected.custom_type ?? ""} maxLength={100} onChange={(event) => onChange(withElement(document, selected.id, { custom_type: event.target.value }))} />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="element-name" className="text-xs font-medium text-muted-foreground">Name</Label>
                <Input id="element-name" aria-label="Element name" value={selected.name} maxLength={100} onChange={(event) => onChange(withElement(document, selected.id, { name: event.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="element-visible-text" className="text-xs font-medium text-muted-foreground">Visible text</Label>
                  <Input id="element-visible-text" value={selected.visible_text ?? ""} maxLength={500} onChange={(event) => onChange(withElement(document, selected.id, { visible_text: event.target.value === "" ? null : event.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="element-visible-state" className="text-xs font-medium text-muted-foreground">Visible state</Label>
                  <Input id="element-visible-state" value={selected.visible_state ?? ""} maxLength={200} onChange={(event) => onChange(withElement(document, selected.id, { visible_state: event.target.value === "" ? null : event.target.value }))} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="element-purpose" className="text-xs font-medium text-muted-foreground">Purpose</Label>
                <Input id="element-purpose" value={selected.purpose} maxLength={1000} onChange={(event) => onChange(withElement(document, selected.id, { purpose: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="element-notes" className="text-xs font-medium text-muted-foreground">Notes</Label>
                <Textarea id="element-notes" value={selected.notes} maxLength={1000} className="min-h-16" onChange={(event) => onChange(withElement(document, selected.id, { notes: event.target.value }))} />
              </div>

              <div className="grid grid-cols-4 gap-2">
                <BoundsField id="element-x" label="X" value={selected.bounds.x} min={0} max={Math.max(0, width - 1)} onChange={(next) => onChange(withElement(document, selected.id, { bounds: constrain({ ...selected.bounds, x: next }, selected, document) }))} />
                <BoundsField id="element-y" label="Y" value={selected.bounds.y} min={0} max={Math.max(0, height - 1)} onChange={(next) => onChange(withElement(document, selected.id, { bounds: constrain({ ...selected.bounds, y: next }, selected, document) }))} />
                <BoundsField id="element-width" label="W" value={selected.bounds.width} min={1} max={width} onChange={(next) => onChange(withElement(document, selected.id, { bounds: constrain({ ...selected.bounds, width: next }, selected, document) }))} />
                <BoundsField id="element-height" label="H" value={selected.bounds.height} min={1} max={height} onChange={(next) => onChange(withElement(document, selected.id, { bounds: constrain({ ...selected.bounds, height: next }, selected, document) }))} />
              </div>

              <div className="space-y-1">
                <Label htmlFor="element-parent" className="text-xs font-medium text-muted-foreground">Parent</Label>
                <Select
                  value={selected.parent_id ?? "none"}
                  onValueChange={(value) => onChange(withElement(document, selected.id, { parent_id: value === "none" ? null : value }))}
                >
                  <SelectTrigger id="element-parent" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No parent</SelectItem>
                    {document.elements
                      .filter((candidate) => candidate.id !== selected.id && boundsContain(candidate.bounds, selected.bounds))
                      .map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Only boxes that fully contain this one can be its parent.</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => reorder(selected, "up")}>Raise</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => reorder(selected, "down")}>Lower</Button>
                <span className="text-[11px] text-muted-foreground">z-index {selected.z_index}</span>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox id="element-reviewed" checked={selected.reviewed} onCheckedChange={(checked) => onChange(withElement(document, selected.id, { reviewed: checked === true }))} />
                <Label htmlFor="element-reviewed" className="text-xs">Reviewed against the image</Label>
              </div>
              {selected.confidence !== null && <p className="text-[11px] text-muted-foreground">Detection confidence {Math.round(selected.confidence * 100)}%</p>}

              <Button type="button" variant="destructive" size="sm" onClick={() => setDeleteTargetId(selected.id)}>
                <Trash2 className="size-3.5" aria-hidden /> Delete element
              </Button>
            </div>
          )}
        </Card>
      </div>

      <AlertDialog open={deleteTargetId !== null} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this element?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const target = document.elements.find((element) => element.id === deleteTargetId);
                const children = target ? document.elements.filter((element) => element.parent_id === target.id) : [];
                return children.length > 0
                  ? `${target?.name} contains ${children.length} element(s). Reparenting keeps them and only removes this box.`
                  : "This removes the box from this map revision. Nothing is deleted from the generated image.";
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {(() => {
              const target = document.elements.find((element) => element.id === deleteTargetId);
              const hasChildren = target ? document.elements.some((element) => element.parent_id === target.id) : false;
              if (!target) return null;
              return (
                <>
                  {hasChildren && (
                    <AlertDialogAction onClick={() => deleteElement(target, "subtree")}>Delete element and children</AlertDialogAction>
                  )}
                  <AlertDialogAction onClick={() => deleteElement(target, "reparent")}>
                    {hasChildren ? "Reparent children and delete" : "Delete element"}
                  </AlertDialogAction>
                </>
              );
            })()}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The render page's interactive half: element review on one saved map revision,
 * detection of a new proposal and the assets produced from this image.
 *
 * Saving is a compare-and-swap: the revision the user read travels with the
 * document, and a conflict keeps the local edits on screen so nothing typed is
 * lost while the caller decides to reload.
 */
export function RenderWorkspace({
  styleId,
  screenId,
  screenName,
  render,
  spec,
  initialElementSet,
  initialOutputs,
  initialOutputsCursor,
  models,
}: {
  styleId: string;
  screenId: string;
  screenName: string;
  render: GameUiRenderSummary;
  spec: ScreenSpec;
  initialElementSet: { id: string; revision: number; document: ElementDocument } | null;
  initialOutputs: GameUiOutputView[];
  initialOutputsCursor: string | null;
  models: ModelCatalogEntry[];
}) {
  const [tab, setTab] = useState<"elements" | "assets">("elements");
  const [elementSetId, setElementSetId] = useState(initialElementSet?.id ?? null);
  const [revision, setRevision] = useState(initialElementSet?.revision ?? 0);
  const [document, setDocument] = useState<ElementDocument | null>(initialElementSet?.document ?? null);
  const [outputs, setOutputs] = useState<GameUiOutputView[]>(initialOutputs);
  const [outputsCursor, setOutputsCursor] = useState<string | null>(initialOutputsCursor);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloadConfirmed, setReloadConfirmed] = useState(false);
  const [detectWarnings, setDetectWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [assetElementId, setAssetElementId] = useState<string | null>(null);

  const imageUrl = render.sourceUrl;
  const assetElement = document?.elements.find((element) => element.id === assetElementId) ?? null;
  const problems = document ? elementGraphProblems(document) : [];

  const reloadFromServer = async () => {
    setBusy("reload");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/renders/${render.id}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "LOAD_FAILED"}: ${body.error?.message ?? "Unable to reload this map"}` });
        return;
      }
      const set = body.latestElementSet ?? body.elementSet ?? null;
      if (set) {
        const parsed = parseElementDocument(set.document, { width: render.width, height: render.height });
        setDocument(parsed);
        setElementSetId(set.id);
        setRevision(set.revision);
      } else {
        setDocument(null);
        setElementSetId(null);
        setRevision(0);
      }
      if (Array.isArray(body.outputs)) setOutputs(body.outputs as GameUiOutputView[]);
      setDirty(false);
      setConflict(false);
      setReloadConfirmed(false);
      setFeedback({ kind: "success", text: "Reloaded the newest saved map. Local edits were discarded." });
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to reload this map" });
    } finally {
      setBusy(null);
    }
  };

  const detect = async () => {
    setBusy("detect");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/renders/${render.id}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "GAME_UI_ANALYSIS_FAILED"}: ${body.error?.message ?? "Detection failed"}` });
        return;
      }
      // A proposal is never saved implicitly: it replaces the local document and
      // waits for the user to accept it with Save.
      const proposed = parseElementDocument(body.document, { width: render.width, height: render.height });
      setDocument(proposed);
      setDirty(true);
      setDetectWarnings(Array.isArray(body.warnings) ? (body.warnings as string[]) : []);
      setFeedback({ kind: "success", text: "Detection finished. Review the boxes, then save the map." });
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error && error.message.startsWith("INVALID_REQUEST") ? error.message : "The detected map could not be read" });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!document) return;
    setBusy("save");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/renders/${render.id}/elements`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, document }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 || body.error?.code === "SCREEN_VERSION_CONFLICT") {
          setConflict(true);
          setFeedback({ kind: "error", text: `${body.error?.code ?? "SCREEN_VERSION_CONFLICT"}: ${body.error?.message ?? "This map has a newer revision"}. Your edits are still here — reload to take the newer revision, or copy them out first.` });
          return;
        }
        setFeedback({ kind: "error", text: `${body.error?.code ?? "SAVE_FAILED"}: ${body.error?.message ?? "Unable to save this map"}` });
        return;
      }
      const saved = body.elementSet ?? body.latestElementSet ?? null;
      if (saved) {
        setElementSetId(saved.id);
        setRevision(saved.revision);
        setDocument(parseElementDocument(saved.document, { width: render.width, height: render.height }));
      }
      setDirty(false);
      setConflict(false);
      setFeedback({ kind: "success", text: "Element map saved as a new revision." });
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to save this map" });
    } finally {
      setBusy(null);
    }
  };

  /** Re-reads the newest outputs; a page already loaded stays, newest first. */
  const refreshOutputs = async () => {
    const response = await fetch(`/api/game-ui/renders/${render.id}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.outputs)) return;
    const fresh = body.outputs as GameUiOutputView[];
    setOutputs((current) => {
      const seen = new Set(fresh.map((output) => output.id));
      return [...fresh, ...current.filter((output) => !seen.has(output.id))];
    });
    setOutputsCursor(typeof body.outputsNextCursor === "string" ? body.outputsNextCursor : null);
  };

  const loadMoreOutputs = async () => {
    if (!outputsCursor || busy !== null) return;
    setBusy("outputs");
    try {
      const response = await fetch(`/api/game-ui/renders/${render.id}?outputsCursor=${encodeURIComponent(outputsCursor)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "LOAD_FAILED"}: ${body.error?.message ?? "Unable to load more outputs"}` });
        return;
      }
      const page = Array.isArray(body.outputs) ? (body.outputs as GameUiOutputView[]) : [];
      setOutputs((current) => [...current, ...page.filter((output) => !current.some((entry) => entry.id === output.id))]);
      setOutputsCursor(typeof body.outputsNextCursor === "string" ? body.outputsNextCursor : null);
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to load more outputs" });
    } finally {
      setBusy(null);
    }
  };

  const elementsPanel = document && imageUrl ? (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => void detect()} disabled={busy !== null}>
          {busy === "detect" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Detecting…</> : <><Wand2 className="size-4" aria-hidden /> Detect elements</>}
        </Button>
        <Button type="button" onClick={() => void save()} disabled={busy !== null || problems.length > 0}>
          {busy === "save" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Save elements
        </Button>
        {dirty && <span role="status" className="text-xs text-warning">Unsaved element edits.</span>}
        {conflict && (
          <Button type="button" variant="outline" onClick={() => { if (reloadConfirmed) void reloadFromServer(); else setReloadConfirmed(true); }}>
            <RefreshCw className="size-4" aria-hidden /> {reloadConfirmed ? "Discard my edits and reload" : "Reload"}
          </Button>
        )}
      </div>
      {detectWarnings.length > 0 && (
        <Alert variant="default" role="status" className="px-3 py-2">
          <AlertDescription>
            <span className="text-xs font-medium">About this detection</span>
            <ul className="mt-1 space-y-1 text-xs text-warning">
              {detectWarnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <ElementEditor
        imageUrl={imageUrl}
        width={render.width}
        height={render.height}
        document={document}
        onChange={(next) => { setDocument(next); setDirty(true); }}
        requirements={spec.requirements.map((requirement) => ({ id: requirement.id, name: requirement.name, required: requirement.required }))}
      />
    </div>
  ) : (
    <Card className="items-start gap-3 p-5">
      <p className="text-sm">This screen has no saved element map yet.</p>
      <p className="text-xs text-muted-foreground">
        {imageUrl ? "Run Detect elements to have the model propose the boxes, then review and save them." : "The generated image preview is unavailable, so elements cannot be reviewed right now."}
      </p>
      <Button type="button" onClick={() => void detect()} disabled={busy !== null || !imageUrl}>
        {busy === "detect" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Detecting…</> : <><Wand2 className="size-4" aria-hidden /> Detect elements</>}
      </Button>
    </Card>
  );

  const assetsPanel = (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Element assets</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Exact extraction keeps the original pixels under your matte; AI reconstruction redraws the element and may differ.
          Nothing here changes the generated screen.
        </p>
      </div>
      {!document ? (
        <p role="status" className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Save an element map first: assets are produced per element of a saved revision.
        </p>
      ) : (
        <ul className="space-y-2">
          {document.elements.map((element) => {
            const elementOutputs = outputs.filter((output) => output.elementId === element.id);
            return (
              <li key={element.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{element.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {kindLabel(element.kind, element.custom_type)} · {element.bounds.width}×{element.bounds.height} at {element.bounds.x},{element.bounds.y}
                  </p>
                  {elementOutputs.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {elementOutputs.length} output(s): {elementOutputs.map((output) => `${output.mode} ${output.alphaStatus} ${output.reviewStatus}`).join(", ")}
                    </p>
                  )}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setAssetElementId(element.id)} disabled={!imageUrl}>
                  Open assets
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {outputsCursor && (
        <Button type="button" variant="outline" className="w-fit" onClick={() => void loadMoreOutputs()} disabled={busy !== null}>
          {busy === "outputs" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Load more outputs
        </Button>
      )}
      {elementSetId && (
        <AssetPackExport
          renderId={render.id}
          elementSetId={elementSetId}
          outputs={outputs.map((output) => {
            const element = document?.elements.find((entry) => entry.id === output.elementId);
            return {
              id: output.id,
              elementId: output.elementId,
              elementName: element?.name ?? output.elementId,
              kind: element?.kind ?? "custom",
              mode: output.mode,
              alphaStatus: output.alphaStatus,
              reviewStatus: output.reviewStatus,
              reviewed: element?.reviewed ?? false,
              // The pack's overlap warning needs the tree, not just the row, and
              // the map revision tells the exporter which outputs are still current.
              parentId: element?.parent_id ?? null,
              elementSetId: output.elementSetId,
            };
          })}
          onRefresh={() => void refreshOutputs()}
        />
      )}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto pb-24 xl:pb-0">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-8 sm:py-8">
        <header className="flex flex-wrap items-center gap-3">
          <Link href={`/game-ui/${styleId}/screens/${screenId}`} className="text-sm text-muted-foreground hover:text-foreground">{screenName}</Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="min-w-0 truncate text-lg font-semibold">Generated screen</h1>
          <Badge variant="secondary">{render.width}×{render.height}</Badge>
          {elementSetId && <Badge variant="secondary">Map revision {revision}</Badge>}
        </header>

        {feedback && (
          <Alert variant={feedback.kind === "error" ? "destructive" : "default"} role="alert" className="px-3 py-2">
            <AlertDescription className={feedback.kind === "error" ? "text-sm" : "text-sm text-success"}>{feedback.text}</AlertDescription>
          </Alert>
        )}

        <Tabs value={tab} onValueChange={(value) => setTab(value as "elements" | "assets")} className="gap-4">
          <TabsList variant="line" className="h-auto! flex flex-wrap gap-1 bg-transparent p-0">
            <TabsTrigger value="elements" aria-current={tab === "elements" ? "page" : undefined} className="h-11 min-h-11 px-3 text-sm font-medium">Elements</TabsTrigger>
            <TabsTrigger value="assets" aria-current={tab === "assets" ? "page" : undefined} className="h-11 min-h-11 px-3 text-sm font-medium">Assets</TabsTrigger>
          </TabsList>
          <TabsContent value="elements">{elementsPanel}</TabsContent>
          <TabsContent value="assets">{assetsPanel}</TabsContent>
        </Tabs>

        {!imageUrl && (
          <p role="status" className="flex items-center gap-2 text-xs text-warning">
            <AlertTriangle className="size-3.5" aria-hidden /> The generated image preview could not be signed; element review and masking need it.
          </p>
        )}
      </div>

      {assetElement && imageUrl && elementSetId && (
        <ElementAssetDialog
          renderId={render.id}
          elementSetId={elementSetId}
          element={assetElement}
          imageUrl={imageUrl}
          imageWidth={render.width}
          imageHeight={render.height}
          outputs={outputs.filter((output) => output.elementId === assetElement.id)}
          models={models}
          onClose={() => setAssetElementId(null)}
          onRefresh={() => void refreshOutputs()}
        />
      )}
    </div>
  );
}
