"use client";

// The Game UI style workspace: the same three steps as the visual Style module
// (references -> style guide -> screens), but the candidate is a
// GameUiStyleSchema and the third step lists game screens instead of images.
// It is deliberately a peer component rather than a branch inside StyleWorkspace:
// the style fields, the validation and the confirmation payload all differ, and a
// shared component would have to carry both contracts at every step.

import { Image as ImageIcon, LoaderCircle, Plus, Trash2, Wand2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ELEMENT_KINDS, KIND_DESCRIPTIONS, type ElementKind } from "@/lib/game-ui/taxonomy";
import type { GameUiScreenSummary, GameUiStyleDetail } from "@/lib/game-ui/service";
import { GameUiStyleSchemaV1, parseGameUiStyleSchema, type GameUiStyleSchema } from "@/lib/game-ui/style-schema";
import { isAnalysisStale } from "@/lib/style/confirmed-definition";
import { MAX_REFERENCE_BYTES, MAX_STYLE_REFERENCES } from "@/lib/style/reference-limits";
import { formatDateTime } from "@/lib/format/datetime";

export type GameUiWorkspaceTab = "references" | "style" | "screens";

const PALETTE_ROLES = ["background", "surface", "primary", "secondary", "accent", "text", "muted", "success", "warning", "danger", "custom"] as const;
const TYPOGRAPHY_ROLES = ["title", "heading", "body", "caption", "numeric", "button"] as const;
const CASINGS = ["unchanged", "uppercase", "lowercase", "title"] as const;
const DENSITIES = ["compact", "balanced", "spacious"] as const;

type ReferenceHash = { id: string; content_hash: string };

/** Structural comparison, so an untouched draft never counts as a candidate change. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function readSchema(value: unknown): GameUiStyleSchema | null {
  const parsed = GameUiStyleSchemaV1.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The strict validator's message, which names the field at fault. */
function schemaProblem(value: GameUiStyleSchema | null): string | null {
  if (!value) return "This style has no analyzed candidate yet";
  try {
    parseGameUiStyleSchema(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^INVALID_GAME_UI_STYLE_SCHEMA: /, "") : "The candidate is invalid";
  }
}

function TextField({ id, label, value, onChange, maxLength, placeholder }: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
  placeholder?: string;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</Label>
      <Input id={id} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function TextAreaField({ id, label, value, onChange, hint }: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</Label>
      <Textarea id={id} value={value} maxLength={1000} className="min-h-20" onChange={(event) => onChange(event.target.value)} />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Invariants and avoid rules are short sentences; one row keeps them editable. */
function RuleList({ label, values, minRows, onChange }: {
  label: string;
  values: string[];
  minRows: number;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        <Button type="button" variant="outline" size="xs" onClick={() => onChange([...values, ""])}>
          <Plus className="size-3" aria-hidden /> Add rule
        </Button>
      </div>
      {values.length === 0 && <p className="text-xs text-muted-foreground">No rules yet.</p>}
      <ul className="space-y-2">
        {values.map((value, index) => (
          <li key={index} className="flex items-center gap-2">
            <Input
              value={value}
              maxLength={500}
              aria-label={`${label} rule ${index + 1}`}
              onChange={(event) => onChange(values.map((entry, position) => (position === index ? event.target.value : entry)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${label} rule ${index + 1}`}
              disabled={values.length <= minRows}
              onClick={() => onChange(values.filter((_, position) => position !== index))}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function GameUiWorkspace({
  styleId,
  initialDetail,
  initialScreens,
  initialScreensCursor,
  initialTab,
  initialAnalysisSnapshot,
  initialReferenceHashes,
  initialConfirmedSchema,
}: {
  styleId: string;
  initialDetail: GameUiStyleDetail;
  initialScreens: GameUiScreenSummary[];
  initialScreensCursor: string | null;
  initialTab: GameUiWorkspaceTab;
  /** The reference snapshot the last analysis ran on, from `analysis_meta`. */
  initialAnalysisSnapshot: ReferenceHash[] | null;
  /** Content hashes of the live references, so staleness is exact on first paint. */
  initialReferenceHashes: Record<string, string>;
  initialConfirmedSchema: unknown;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<GameUiWorkspaceTab>(initialTab);
  const [detail, setDetail] = useState(initialDetail);
  const [draft, setDraft] = useState<GameUiStyleSchema | null>(() => readSchema(initialDetail.schema));
  const [analysisSnapshot, setAnalysisSnapshot] = useState<ReferenceHash[] | null>(initialAnalysisSnapshot);
  const [referenceHashes, setReferenceHashes] = useState<Record<string, string>>(initialReferenceHashes);
  const [screens, setScreens] = useState<GameUiScreenSummary[]>(initialScreens);
  const [screensCursor, setScreensCursor] = useState<string | null>(initialScreensCursor);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [newScreenName, setNewScreenName] = useState("");
  const [newScreenDescription, setNewScreenDescription] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const references = detail.references;
  const problem = schemaProblem(draft);
  // A reference the client has never hashed reads as changed, which is what an
  // upload or a replacement is: the recorded analysis no longer describes it.
  const analysisStale = useMemo(
    () => isAnalysisStale({ reference_snapshot: analysisSnapshot }, references.map((reference) => ({ id: reference.id, content_hash: referenceHashes[reference.id] ?? "" }))),
    [analysisSnapshot, referenceHashes, references],
  );
  const confirmed = detail.confirmedAt !== null && detail.styleRevision !== null;
  const candidateChanged = initialConfirmedSchema !== null && draft !== null && !sameValue(draft, initialConfirmedSchema);
  const unsaved = draft !== null && !sameValue(draft, detail.schema);
  const canConfirm = draft !== null && problem === null && !analysisStale && detail.analyzedAt !== null && references.length > 0 && (!confirmed || candidateChanged);
  const canSaveSchema = draft !== null && problem === null && busy === null;

  const refresh = useCallback(async (): Promise<GameUiStyleDetail | null> => {
    const response = await fetch(`/api/game-ui/styles/${styleId}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.style) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "LOAD_FAILED"}: ${body.error?.message ?? "Unable to load this style"}` });
      return null;
    }
    const next = body.style as GameUiStyleDetail;
    setDetail(next);
    // Only hashes of references that are still live may be reused; a new id has no
    // recorded hash, so the analysis correctly reads as stale until it is re-run.
    setReferenceHashes((current) => {
      const kept: Record<string, string> = {};
      for (const reference of next.references) kept[reference.id] = current[reference.id] ?? "";
      return kept;
    });
    return next;
  }, [styleId]);

  const updateDraft = (mutate: (current: GameUiStyleSchema) => GameUiStyleSchema) => {
    setDraft((current) => (current ? mutate(current) : current));
  };

  const upload = async (files: File[]) => {
    if (busy !== null || files.length === 0) return;
    const slots = MAX_STYLE_REFERENCES - references.length;
    if (slots <= 0) {
      setFeedback({ kind: "error", text: `A style supports at most ${MAX_STYLE_REFERENCES} reference images. Remove one before adding another.` });
      return;
    }
    const problems: string[] = [];
    const valid: File[] = [];
    for (const file of files) {
      const mime = (file.type || "").split(";")[0].trim();
      if (mime !== "image/png" && mime !== "image/jpeg") {
        problems.push(`${file.name}: only PNG and JPEG images are supported.`);
        continue;
      }
      if (file.size <= 0 || file.size > MAX_REFERENCE_BYTES) {
        problems.push(`${file.name}: each reference must be 5 MB or smaller.`);
        continue;
      }
      valid.push(file);
    }
    const queued = valid.slice(0, slots);
    if (valid.length > queued.length) problems.push(`${valid.length - queued.length} file(s) were not sent because this style already has ${references.length} reference images.`);
    if (queued.length === 0) {
      setFeedback({ kind: "error", text: problems.join(" ") });
      return;
    }
    setBusy("upload");
    setStatus(`Uploading ${queued.length} reference image(s)…`);
    setFeedback(null);
    try {
      const form = new FormData();
      for (const file of queued) form.append("files", file);
      const response = await fetch(`/api/styles/${styleId}/references`, { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      await refresh();
      if (!response.ok) {
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "UPLOAD_FAILED"}: ${body.error?.message ?? "Upload failed"}. Files that were already accepted are kept — check the list below.` });
        return;
      }
      const accepted = Array.isArray(body.references) ? body.references.length : queued.length;
      setStatus("");
      setFeedback({
        kind: problems.length ? "error" : "success",
        text: `${problems.length ? `${problems.join(" ")} ` : ""}${accepted} reference image(s) added. Analyze references when the set is complete.`,
      });
    } catch {
      await refresh();
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Upload failed. Files that were already accepted are kept — check the list below." });
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeReference = async (referenceId: string) => {
    if (busy !== null) return;
    setBusy(referenceId);
    setStatus("Removing the reference from the editable set…");
    try {
      const response = await fetch(`/api/styles/${styleId}/references/${referenceId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      await refresh();
      if (!response.ok) {
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "DELETE_FAILED"}: ${body.error?.message ?? "Unable to remove this reference"}` });
        return;
      }
      setStatus("");
      setFeedback({ kind: "success", text: "Reference removed from the editable set. Analyze references again before you confirm the style." });
    } catch {
      await refresh();
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to remove this reference" });
    } finally {
      setBusy(null);
    }
  };

  const analyze = async () => {
    if (busy !== null || references.length === 0) return;
    setBusy("analyze");
    setStatus("Analyzing the reference images. This can take up to two minutes…");
    setFeedback(null);
    try {
      const response = await fetch(`/api/styles/${styleId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      const fresh = await refresh();
      setStatus("");
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "STYLE_ANALYSIS_FAILED"}: ${body.error?.message ?? "Analysis failed"}. The reference images are kept.` });
        return;
      }
      if (fresh) {
        setDraft(readSchema(fresh.schema));
        // The analysis ran on exactly the live set, so it is current again.
        setAnalysisSnapshot(fresh.references.map((reference) => ({ id: reference.id, content_hash: referenceHashes[reference.id] ?? "" })));
      }
      setFeedback({ kind: "success", text: "Analysis complete. Review the style guide, then confirm it." });
    } catch {
      await refresh();
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Analysis failed. The reference images are kept." });
    } finally {
      setBusy(null);
    }
  };

  const saveSchema = async () => {
    if (!canSaveSchema || !draft) return;
    setBusy("save");
    setStatus("Saving the style guide…");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/styles/${styleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema: draft, expectedUpdatedAt: detail.updatedAt }),
      });
      const body = await response.json().catch(() => ({}));
      setStatus("");
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to save the style guide"}` });
        await refresh();
        return;
      }
      if (body.style) setDetail(body.style as GameUiStyleDetail);
      setFeedback({ kind: "success", text: "Style guide saved. Confirm it when the rules are right." });
    } catch {
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to save the style guide" });
    } finally {
      setBusy(null);
    }
  };

  const confirmStyle = async () => {
    if (busy !== null) return;
    setBusy("confirm");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/styles/${styleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active", expectedUpdatedAt: detail.updatedAt }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "CONFIRM_FAILED"}: ${body.error?.message ?? "Unable to confirm this style"}` });
        await refresh();
        return;
      }
      if (body.style) setDetail(body.style as GameUiStyleDetail);
      setFeedback({ kind: "success", text: "Style confirmed. New screens are generated from this revision." });
      setTab("screens");
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to confirm this style" });
    } finally {
      setBusy(null);
    }
  };

  const createScreen = async () => {
    const name = newScreenName.trim();
    if (!name || busy !== null) return;
    setBusy("screen");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/styles/${styleId}/screens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          spec: { schema_version: 1, name, description: newScreenDescription.trim(), layout_notes: "", requirements: [] },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create the screen"}` });
        return;
      }
      const screenId = typeof body.screen?.id === "string" ? body.screen.id : null;
      setNewScreenName("");
      setNewScreenDescription("");
      if (screenId) router.push(`/game-ui/${styleId}/screens/${screenId}`);
      else router.refresh();
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to create the screen" });
    } finally {
      setBusy(null);
    }
  };

  const loadMoreScreens = async () => {
    if (!screensCursor || busy !== null) return;
    setBusy("screens");
    try {
      const response = await fetch(`/api/game-ui/styles/${styleId}/screens?cursor=${encodeURIComponent(screensCursor)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "LOAD_FAILED"}: ${body.error?.message ?? "Unable to load more screens"}` });
        return;
      }
      const page = Array.isArray(body.screens) ? (body.screens as GameUiScreenSummary[]) : [];
      setScreens((current) => [...current, ...page.filter((screen) => !current.some((entry) => entry.id === screen.id))]);
      setScreensCursor(typeof body.nextCursor === "string" ? body.nextCursor : null);
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to load more screens" });
    } finally {
      setBusy(null);
    }
  };

  const referencesScreen = (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div>
          <h2 className="text-lg font-semibold">Reference images</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload up to {MAX_STYLE_REFERENCES} PNG or JPEG screenshots, 5 MB each. They define the interface look — palette,
            typography, frames and materials — not the content of the screens you generate later.
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg"
          aria-label="Upload Game UI reference images"
          className="block w-full text-sm text-muted-foreground file:mr-3 file:h-11 file:rounded-md file:border file:border-border file:bg-background file:px-4 file:text-sm file:font-medium"
          onChange={(event) => void upload(Array.from(event.target.files ?? []))}
        />
        <p className="text-xs text-muted-foreground">
          {references.length === 0
            ? "No references yet."
            : `${references.length} of ${MAX_STYLE_REFERENCES} reference images. Reference ${analysisStale ? "changed since the last analysis" : "set analyzed"}.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void analyze()} disabled={references.length === 0 || busy !== null}>
            {busy === "analyze" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Analyzing…</> : <><Wand2 className="size-4" aria-hidden /> Analyze references</>}
          </Button>
          <Button type="button" variant="outline" onClick={() => setTab("style")}>
            Review the style guide
          </Button>
        </div>
      </Card>

      {references.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {references.map((reference) => (
            <li key={reference.id} className="space-y-2">
              <div className="overflow-hidden rounded-lg border border-border bg-accent">
                {reference.signed_url ? (
                  <Image
                    src={reference.signed_url}
                    alt="Style reference"
                    width={480}
                    height={360}
                    sizes="(min-width:1024px) 22vw, 45vw"
                    className="h-36 w-full object-cover"
                  />
                ) : (
                  <span className="flex h-36 items-center justify-center text-xs text-muted-foreground">Preview unavailable</span>
                )}
              </div>
              <Button type="button" variant="outline" size="sm" className="w-full" disabled={busy !== null} onClick={() => void removeReference(reference.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const styleScreen = (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{confirmed && !candidateChanged ? "Style guide" : "Review style"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {confirmed && !candidateChanged
            ? "These rules define how every screen from this style is rendered. They change only when you confirm an update."
            : "Check every field the analysis produced. Nothing is used for generation until you confirm it."}
        </p>
      </div>

      {(detail.warnings.length > 0 || (draft?.uncertainties.length ?? 0) > 0) && (
        <Alert variant="default" role="status" className="px-3 py-2">
          <AlertDescription>
            <span className="text-sm font-medium">Before you confirm</span>
            <ul className="mt-1 space-y-1 text-xs text-warning">
              {detail.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              {(draft?.uncertainties ?? []).map((entry) => <li key={`${entry.field}:${entry.question}`}>{entry.field}: {entry.question}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert variant={draft === null ? "default" : "destructive"} role="alert" className="px-3 py-2">
          <AlertDescription className="text-sm">
            {draft === null ? "No analysis yet. Add reference images and run Analyze references to see the detected style." : problem}
          </AlertDescription>
        </Alert>
      )}

      {analysisStale && references.length > 0 && (
        <Alert variant="default" role="status" className="px-3 py-2">
          <AlertDescription className="text-sm text-warning">
            The reference set changed after the analysis was run, so this style cannot be confirmed yet. Analyze references
            again, then review the result.
          </AlertDescription>
        </Alert>
      )}

      {draft && (
        <div className="space-y-4">
          <Card className="gap-3 p-5">
            <TextAreaField id="game-ui-visual-language" label="Visual language" value={draft.visual_language} onChange={(value) => updateDraft((current) => ({ ...current, visual_language: value }))} />
          </Card>

          <Card className="gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Palette</h3>
                <p className="text-xs text-muted-foreground">Colors the reference set actually uses. The id is referenced by the generation prompt.</p>
              </div>
              <Button type="button" variant="outline" size="xs" disabled={draft.palette.length >= 32} onClick={() => updateDraft((current) => ({ ...current, palette: [...current.palette, { id: `color-${current.palette.length + 1}`, role: "accent", color: "#888888", notes: "" }] }))}>
                <Plus className="size-3" aria-hidden /> Add color
              </Button>
            </div>
            <ul className="space-y-3">
              {draft.palette.map((token, index) => (
                <li key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_10rem_8rem_1fr_auto] sm:items-end">
                  <TextField id={`palette-id-${index}`} label="Id" value={token.id} maxLength={40} onChange={(value) => updateDraft((current) => ({ ...current, palette: current.palette.map((entry, position) => (position === index ? { ...entry, id: value } : entry)) }))} />
                  <div className="space-y-1">
                    <Label htmlFor={`palette-role-${index}`} className="text-xs font-medium text-muted-foreground">Role</Label>
                    <Select value={token.role} onValueChange={(value) => updateDraft((current) => ({ ...current, palette: current.palette.map((entry, position) => (position === index ? { ...entry, role: value as typeof entry.role } : entry)) }))}>
                      <SelectTrigger id={`palette-role-${index}`} className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{PALETTE_ROLES.map((role) => <SelectItem key={role} value={role}>{role}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`palette-color-${index}`} className="text-xs font-medium text-muted-foreground">Color</Label>
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="size-6 shrink-0 rounded border border-border" style={{ backgroundColor: token.color }} />
                      <Input id={`palette-color-${index}`} value={token.color} maxLength={9} onChange={(event) => updateDraft((current) => ({ ...current, palette: current.palette.map((entry, position) => (position === index ? { ...entry, color: event.target.value } : entry)) }))} />
                    </div>
                  </div>
                  <TextField id={`palette-notes-${index}`} label="Notes" value={token.notes} maxLength={500} onChange={(value) => updateDraft((current) => ({ ...current, palette: current.palette.map((entry, position) => (position === index ? { ...entry, notes: value } : entry)) }))} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove palette color ${token.id}`} disabled={draft.palette.length <= 1} onClick={() => updateDraft((current) => ({ ...current, palette: current.palette.filter((_, position) => position !== index) }))}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Typography</h3>
                <p className="text-xs text-muted-foreground">Appearance only. The style never bundles or licenses a font file.</p>
              </div>
              <Button type="button" variant="outline" size="xs" disabled={draft.typography.length >= 12} onClick={() => updateDraft((current) => ({ ...current, typography: [...current.typography, { role: "body", family_description: "", weight: "", casing: "unchanged", effects: "" }] }))}>
                <Plus className="size-3" aria-hidden /> Add text style
              </Button>
            </div>
            <ul className="space-y-3">
              {draft.typography.map((rule, index) => (
                <li key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_8rem_8rem_1fr_auto] sm:items-end">
                  <div className="space-y-1">
                    <Label htmlFor={`type-role-${index}`} className="text-xs font-medium text-muted-foreground">Role</Label>
                    <Select value={rule.role} onValueChange={(value) => updateDraft((current) => ({ ...current, typography: current.typography.map((entry, position) => (position === index ? { ...entry, role: value as typeof entry.role } : entry)) }))}>
                      <SelectTrigger id={`type-role-${index}`} className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{TYPOGRAPHY_ROLES.map((role) => <SelectItem key={role} value={role}>{role}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <TextField id={`type-family-${index}`} label="Family description" value={rule.family_description} maxLength={1000} onChange={(value) => updateDraft((current) => ({ ...current, typography: current.typography.map((entry, position) => (position === index ? { ...entry, family_description: value } : entry)) }))} />
                  <TextField id={`type-weight-${index}`} label="Weight" value={rule.weight} maxLength={100} onChange={(value) => updateDraft((current) => ({ ...current, typography: current.typography.map((entry, position) => (position === index ? { ...entry, weight: value } : entry)) }))} />
                  <div className="space-y-1">
                    <Label htmlFor={`type-casing-${index}`} className="text-xs font-medium text-muted-foreground">Casing</Label>
                    <Select value={rule.casing} onValueChange={(value) => updateDraft((current) => ({ ...current, typography: current.typography.map((entry, position) => (position === index ? { ...entry, casing: value as typeof entry.casing } : entry)) }))}>
                      <SelectTrigger id={`type-casing-${index}`} className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{CASINGS.map((casing) => <SelectItem key={casing} value={casing}>{casing}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <TextField id={`type-effects-${index}`} label="Effects" value={rule.effects} maxLength={500} onChange={(value) => updateDraft((current) => ({ ...current, typography: current.typography.map((entry, position) => (position === index ? { ...entry, effects: value } : entry)) }))} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove typography row ${index + 1}`} disabled={draft.typography.length <= 1} onClick={() => updateDraft((current) => ({ ...current, typography: current.typography.filter((_, position) => position !== index) }))}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="gap-3 p-5">
            <h3 className="text-sm font-semibold">Layout</h3>
            <div className="space-y-1">
              <Label htmlFor="layout-density" className="text-xs font-medium text-muted-foreground">Density</Label>
              <Select value={draft.layout.density} onValueChange={(value) => updateDraft((current) => ({ ...current, layout: { ...current.layout, density: value as typeof current.layout.density } }))}>
                <SelectTrigger id="layout-density" className="w-full sm:max-w-48"><SelectValue /></SelectTrigger>
                <SelectContent>{DENSITIES.map((density) => <SelectItem key={density} value={density}>{density}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextAreaField id="layout-spacing" label="Spacing rules" value={draft.layout.spacing_rules} onChange={(value) => updateDraft((current) => ({ ...current, layout: { ...current.layout, spacing_rules: value } }))} hint="Relative spacing only: references differ in size." />
              <TextAreaField id="layout-alignment" label="Alignment rules" value={draft.layout.alignment_rules} onChange={(value) => updateDraft((current) => ({ ...current, layout: { ...current.layout, alignment_rules: value } }))} />
              <TextAreaField id="layout-safe-area" label="Safe area rules" value={draft.layout.safe_area_rules} onChange={(value) => updateDraft((current) => ({ ...current, layout: { ...current.layout, safe_area_rules: value } }))} />
              <TextAreaField id="layout-hierarchy" label="Hierarchy rules" value={draft.layout.hierarchy_rules} onChange={(value) => updateDraft((current) => ({ ...current, layout: { ...current.layout, hierarchy_rules: value } }))} />
            </div>
          </Card>

          <Card className="gap-3 p-5">
            <h3 className="text-sm font-semibold">Shape, surface and iconography</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TextAreaField id="shape-corner" label="Corner rules" value={draft.shape.corner_rules} onChange={(value) => updateDraft((current) => ({ ...current, shape: { ...current.shape, corner_rules: value } }))} />
              <TextAreaField id="shape-border" label="Border rules" value={draft.shape.border_rules} onChange={(value) => updateDraft((current) => ({ ...current, shape: { ...current.shape, border_rules: value } }))} />
              <TextAreaField id="shape-silhouette" label="Silhouette rules" value={draft.shape.silhouette_rules} onChange={(value) => updateDraft((current) => ({ ...current, shape: { ...current.shape, silhouette_rules: value } }))} />
              <TextAreaField id="surface-materials" label="Materials" value={draft.surface.materials} onChange={(value) => updateDraft((current) => ({ ...current, surface: { ...current.surface, materials: value } }))} />
              <TextAreaField id="surface-shading" label="Shading" value={draft.surface.shading} onChange={(value) => updateDraft((current) => ({ ...current, surface: { ...current.surface, shading: value } }))} />
              <TextAreaField id="surface-shadows" label="Shadows" value={draft.surface.shadows} onChange={(value) => updateDraft((current) => ({ ...current, surface: { ...current.surface, shadows: value } }))} />
              <TextAreaField id="surface-highlights" label="Highlights" value={draft.surface.highlights} onChange={(value) => updateDraft((current) => ({ ...current, surface: { ...current.surface, highlights: value } }))} />
              <TextAreaField id="icon-construction" label="Icon construction" value={draft.iconography.construction} onChange={(value) => updateDraft((current) => ({ ...current, iconography: { ...current.iconography, construction: value } }))} />
              <TextAreaField id="icon-stroke" label="Stroke rules" value={draft.iconography.stroke_rules} onChange={(value) => updateDraft((current) => ({ ...current, iconography: { ...current.iconography, stroke_rules: value } }))} />
              <TextAreaField id="icon-detail" label="Detail level" value={draft.iconography.detail_level} onChange={(value) => updateDraft((current) => ({ ...current, iconography: { ...current.iconography, detail_level: value } }))} />
            </div>
          </Card>

          <Card className="gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Components</h3>
                <p className="text-xs text-muted-foreground">One row per kind the reference set actually showed. An empty appearance is a warning, not an invention.</p>
              </div>
              <Button type="button" variant="outline" size="xs" disabled={draft.components.length >= 32} onClick={() => updateDraft((current) => ({ ...current, components: [...current.components, { kind: "button", appearance: "", text_rules: "", composition_rules: "" }] }))}>
                <Plus className="size-3" aria-hidden /> Add component
              </Button>
            </div>
            <ul className="space-y-3">
              {draft.components.map((component, index) => (
                <li key={index} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor={`component-kind-${index}`} className="text-xs font-medium text-muted-foreground">Kind</Label>
                      <Select value={component.kind} onValueChange={(value) => updateDraft((current) => ({ ...current, components: current.components.map((entry, position) => (position === index ? { ...entry, kind: value as ElementKind } : entry)) }))}>
                        <SelectTrigger id={`component-kind-${index}`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{ELEMENT_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">{KIND_DESCRIPTIONS[component.kind]}</p>
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove component ${index + 1}`} disabled={draft.components.length <= 1} onClick={() => updateDraft((current) => ({ ...current, components: current.components.filter((_, position) => position !== index) }))}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <TextAreaField id={`component-appearance-${index}`} label="Appearance" value={component.appearance} onChange={(value) => updateDraft((current) => ({ ...current, components: current.components.map((entry, position) => (position === index ? { ...entry, appearance: value } : entry)) }))} />
                    <TextAreaField id={`component-text-${index}`} label="Text rules" value={component.text_rules} onChange={(value) => updateDraft((current) => ({ ...current, components: current.components.map((entry, position) => (position === index ? { ...entry, text_rules: value } : entry)) }))} />
                    <TextAreaField id={`component-composition-${index}`} label="Composition rules" value={component.composition_rules} onChange={(value) => updateDraft((current) => ({ ...current, components: current.components.map((entry, position) => (position === index ? { ...entry, composition_rules: value } : entry)) }))} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="gap-4 p-5">
            <RuleList label="Invariants" values={draft.invariants} minRows={1} onChange={(next) => updateDraft((current) => ({ ...current, invariants: next }))} />
            <RuleList label="Avoid" values={draft.avoid} minRows={0} onChange={(next) => updateDraft((current) => ({ ...current, avoid: next }))} />
            <p className="text-[11px] text-muted-foreground">
              Invariants apply to new content only: a subject or label copied from a reference is not a rule.
            </p>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => void saveSchema()} disabled={!canSaveSchema || !unsaved}>
          {busy === "save" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Save style guide
        </Button>
        {confirmed && !candidateChanged ? (
          <Button type="button" onClick={() => setTab("screens")}>Create a screen</Button>
        ) : (
          <Button type="button" onClick={() => void confirmStyle()} disabled={!canConfirm || busy !== null}>
            {busy === "confirm" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Confirming…</> : "Confirm style & continue"}
          </Button>
        )}
        {unsaved && <span role="status" className="text-xs text-warning">The style guide has unsaved edits.</span>}
      </div>
    </div>
  );

  const screensScreen = (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div>
          <h2 className="text-lg font-semibold">Screens</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A screen is one layout to generate from this style: describe it, optionally attach a wireframe, list the elements it
            must contain, then generate and review the result.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField id="new-screen-name" label="Screen name" value={newScreenName} maxLength={100} placeholder="e.g. Battle HUD" onChange={setNewScreenName} />
          <TextField id="new-screen-description" label="Description (optional)" value={newScreenDescription} maxLength={2000} placeholder="e.g. Avatar, health bar and coin counter over a battle scene" onChange={setNewScreenDescription} />
        </div>
        <Button type="button" className="w-fit" onClick={() => void createScreen()} disabled={!newScreenName.trim() || busy !== null}>
          <Plus className="size-4" aria-hidden /> Create screen
        </Button>
      </Card>

      {screens.length === 0 ? (
        <p role="status" className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No screens yet. Create one to describe what this interface has to show.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {screens.map((screen) => (
            <li key={screen.id}>
              <Link href={`/game-ui/${styleId}/screens/${screen.id}`} className="group block h-full">
                <Card className="h-full gap-0 overflow-hidden p-0 transition-colors group-hover:border-primary/50">
                  {screen.wireframeUrl ? (
                    <Image src={screen.wireframeUrl} alt={`${screen.name} wireframe`} width={480} height={270} sizes="(min-width:1024px) 30vw, 92vw" className="h-32 w-full bg-accent object-contain" />
                  ) : (
                    <div aria-hidden className="flex h-32 w-full items-center justify-center bg-accent"><ImageIcon className="size-6 text-muted-foreground" /></div>
                  )}
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <p className="truncate font-medium">{screen.name}</p>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">Revision {screen.draftRevision}</Badge>
                      <Badge variant="secondary">{screen.renderCount} generated</Badge>
                    </div>
                    <p className="mt-auto text-xs text-muted-foreground">
                      {screen.spec.requirements.length} required element{screen.spec.requirements.length === 1 ? "" : "s"}
                    </p>
                    {formatDateTime(screen.updatedAt) && <p className="text-xs text-muted-foreground">Updated {formatDateTime(screen.updatedAt)}</p>}
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {screensCursor && (
        <Button type="button" variant="outline" onClick={() => void loadMoreScreens()} disabled={busy !== null}>
          {busy === "screens" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Load more screens
        </Button>
      )}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto pb-24 xl:pb-0">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <Link href="/game-ui" className="text-sm text-muted-foreground hover:text-foreground">Game UI styles</Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="min-w-0 truncate text-lg font-semibold">{detail.name}</h1>
          <Badge variant={detail.status === "active" ? "default" : "secondary"}>{detail.status === "active" ? "Active" : "Draft"}</Badge>
        </header>

        {feedback && (
          <Alert variant={feedback.kind === "error" ? "destructive" : "default"} role="alert" className="mb-4 px-3 py-2">
            <AlertDescription className={feedback.kind === "error" ? "text-sm" : "text-sm text-success"}>{feedback.text}</AlertDescription>
          </Alert>
        )}
        {status && <p role="status" aria-live="polite" className="mb-4 text-xs text-muted-foreground">{status}</p>}

        <Tabs value={tab} onValueChange={(value) => { setTab(value as GameUiWorkspaceTab); setFeedback(null); }} className="gap-4">
          <TabsList variant="line" className="h-auto! flex flex-wrap gap-1 bg-transparent p-0">
            {([["references", "References"], ["style", "Style guide"], ["screens", "Screens"]] as Array<[GameUiWorkspaceTab, string]>).map(([value, label]) => (
              <TabsTrigger key={value} value={value} aria-current={tab === value ? "page" : undefined} className="h-11 min-h-11 px-3 text-sm font-medium">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="references">{referencesScreen}</TabsContent>
          <TabsContent value="style">{styleScreen}</TabsContent>
          <TabsContent value="screens">{screensScreen}</TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
