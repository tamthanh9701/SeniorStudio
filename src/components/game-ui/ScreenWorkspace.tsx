"use client";

// One screen draft: what the screen must contain, the wireframe it is laid out
// on, the generation settings and the images that came out.  Two rules drive the
// shape of this component:
//   - the requirement list is a local draft.  Suggesting elements and editing rows
//     only change this component's state; the server sees them when Save is pressed
//     with the revision the caller read.
//   - generation is planned on the server and consented to by hash.  Whatever the
//     plan route returns is the only hash this component may send back.

import { ChevronDown, LoaderCircle, Plus, Trash2, Upload, Wand2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AiJobSchema, isTerminalStatus, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { useModuleJobs } from "@/lib/ai/use-module-jobs";
import { JOB_STATUS_LABELS, jobErrorMessage, sizeLabel } from "@/lib/ai/presentation";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { ScreenRequirement, ScreenSpec } from "@/lib/game-ui/contracts";
import type { GameUiReferenceView, GameUiRenderSummary, GameUiScreenSummary } from "@/lib/game-ui/service";
import { ELEMENT_KINDS, KIND_DESCRIPTIONS } from "@/lib/game-ui/taxonomy";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format/datetime";

/** A page of renders; older images are reached with the cursor the server returns. */
const RENDER_PAGE_SIZE = 25;
const MAX_WIREFRAME_BYTES = 5 * 1024 * 1024;
const WIREFRAME_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

type Plan = {
  effectiveModelId: string;
  requestedModelId: string;
  provider: string;
  size: string;
  quality: string;
  count: number;
  referenceIds: string[];
  omittedReferenceIds: string[];
  explanation: string;
  compiledPrompt: string;
  planHash: string;
};

/** jsdom predates crypto.randomUUID; a v4-shaped id keeps the document valid there. */
function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const digits = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  digits[12] = "4";
  digits[16] = ((Number.parseInt(digits[16], 16) & 0x3) | 0x8).toString(16);
  const joined = digits.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function buildSpec(screen: GameUiScreenSummary, name: string, description: string, layoutNotes: string, requirements: ScreenRequirement[]): ScreenSpec {
  return {
    schema_version: 1,
    name: name.trim() || screen.name,
    description,
    layout_notes: layoutNotes,
    requirements,
  };
}

/** "1024x1536" -> [1024, 1536]; null when the model chooses the size itself. */
function parseSize(value: string): [number, number] | null {
  const match = /^(\d+)x(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export default function ScreenWorkspace({
  styleId,
  screen,
  initialRenders,
  initialRendersCursor,
  wireframeDimensions,
  references,
  models,
  initialJobs,
}: {
  styleId: string;
  screen: GameUiScreenSummary;
  initialRenders: GameUiRenderSummary[];
  initialRendersCursor: string | null;
  /** Decoded size of the attached wireframe, so the output ratio can be compared. */
  wireframeDimensions: { width: number; height: number } | null;
  references: GameUiReferenceView[];
  models: ModelCatalogEntry[];
  initialJobs: ProjectJobFeedItem[];
}) {
  const [name, setName] = useState(screen.spec.name);
  const [description, setDescription] = useState(screen.spec.description);
  const [layoutNotes, setLayoutNotes] = useState(screen.spec.layout_notes);
  const [requirements, setRequirements] = useState<ScreenRequirement[]>(screen.spec.requirements);
  const [revision, setRevision] = useState(screen.draftRevision);
  const [wireframeVersionId, setWireframeVersionId] = useState(screen.wireframeVersionId);
  const [wireframeUrl, setWireframeUrl] = useState(screen.wireframeUrl);
  const [wireframeSize, setWireframeSize] = useState(wireframeDimensions);
  const [dirty, setDirty] = useState(false);
  const [suggestWarnings, setSuggestWarnings] = useState<string[]>([]);
  const [renders, setRenders] = useState<GameUiRenderSummary[]>(initialRenders);
  const [rendersCursor, setRendersCursor] = useState<string | null>(initialRendersCursor);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [size, setSize] = useState<string>(models[0]?.sizes[0] ?? "1024x1024");
  const [quality, setQuality] = useState<string>(models[0]?.qualities[0] ?? "auto");
  const [count, setCount] = useState<1 | 2 | 3 | 4>(1);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>(() => references.map((reference) => reference.id));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [composerOpen, setComposerOpen] = useState(true);
  const wireframeInputRef = useRef<HTMLInputElement>(null);
  const { items: jobs, addJob } = useModuleJobs({ module: "style", styleId }, initialJobs);
  const activeJobIds = useMemo(() => jobs.filter(({ job }) => !isTerminalStatus(job.status)).map(({ job }) => job.id), [jobs]);
  const previousActiveJobIds = useRef(activeJobIds);

  const selectedModel = useMemo(() => models.find((model) => model.id === modelId), [modelId, models]);
  const spec = buildSpec(screen, name, description, layoutNotes, requirements);
  const outputRatio = size === "auto" ? null : parseSize(size);
  const wireframeRatioWarning =
    wireframeSize && outputRatio
      ? Math.abs(wireframeSize.width / wireframeSize.height - outputRatio[0] / outputRatio[1]) > 0.02
      : false;

  const saveDraft = async () => {
    if (busy !== null) return;
    setBusy("save");
    setStatus("Saving the screen draft…");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/screens/${screen.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, name: spec.name, spec, wireframeVersionId }),
      });
      const body = await response.json().catch(() => ({}));
      setStatus("");
      if (!response.ok) {
        setFeedback({
          kind: "error",
          text: `${body.error?.code ?? "SAVE_FAILED"}: ${body.error?.message ?? "Unable to save this screen"}${
            body.error?.code === "SCREEN_VERSION_CONFLICT" ? " Reload the page to see the newer revision." : ""
          }`,
        });
        return;
      }
      if (typeof body.screen?.draftRevision === "number") setRevision(body.screen.draftRevision);
      setDirty(false);
      setFeedback({ kind: "success", text: "Screen draft saved." });
    } catch {
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to save this screen" });
    } finally {
      setBusy(null);
    }
  };

  const suggest = async () => {
    if (busy !== null) return;
    setBusy("suggest");
    setStatus("Suggesting the elements this screen needs. This can take up to two minutes…");
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/screens/${screen.id}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      const body = await response.json().catch(() => ({}));
      setStatus("");
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "GAME_UI_ANALYSIS_FAILED"}: ${body.error?.message ?? "The suggestion failed"}. The draft is unchanged.` });
        return;
      }
      // A proposal is not a save: it replaces the local list and waits for Save.
      const proposed = body.spec as ScreenSpec | undefined;
      if (proposed) {
        setName(proposed.name);
        setDescription(proposed.description);
        setLayoutNotes(proposed.layout_notes);
        setRequirements(proposed.requirements);
        setDirty(true);
      }
      setSuggestWarnings(Array.isArray(body.warnings) ? (body.warnings as string[]) : []);
      setFeedback({ kind: "success", text: "Suggested elements are in the list below. Review them, then save the draft." });
    } catch {
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: The suggestion failed. The draft is unchanged." });
    } finally {
      setBusy(null);
    }
  };

  const uploadWireframe = async (file: File) => {
    if (busy !== null) return;
    const mime = (file.type || "").split(";")[0].trim();
    if (!WIREFRAME_MIME_TYPES.includes(mime)) {
      setFeedback({ kind: "error", text: `${file.name}: a wireframe must be a PNG, JPEG or WebP image.` });
      return;
    }
    if (file.size <= 0 || file.size > MAX_WIREFRAME_BYTES) {
      setFeedback({ kind: "error", text: `${file.name}: a wireframe must be 5 MB or smaller.` });
      return;
    }
    setBusy("wireframe");
    setStatus("Uploading the wireframe…");
    setFeedback(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/game-ui/styles/${styleId}/wireframes`, { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "UPLOAD_FAILED"}: ${body.error?.message ?? "Unable to upload the wireframe"}` });
        return;
      }
      const versionId = typeof body.versionId === "string" ? body.versionId : null;
      if (!versionId) {
        setStatus("");
        setFeedback({ kind: "error", text: "UPLOAD_FAILED: the server did not return a wireframe version" });
        return;
      }
      // The draft is saved with the new wireframe in the same step, so the screen
      // never points at a version the user has not seen.
      const patch = await fetch(`/api/game-ui/screens/${screen.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, name: spec.name, spec, wireframeVersionId: versionId }),
      });
      const patchBody = await patch.json().catch(() => ({}));
      setStatus("");
      if (!patch.ok) {
        setFeedback({ kind: "error", text: `${patchBody.error?.code ?? "SAVE_FAILED"}: ${patchBody.error?.message ?? "The wireframe was stored but the screen could not be updated"}` });
        return;
      }
      if (typeof patchBody.screen?.draftRevision === "number") setRevision(patchBody.screen.draftRevision);
      setWireframeVersionId(versionId);
      setWireframeUrl(typeof body.signedUrl === "string" ? body.signedUrl : null);
      setWireframeSize(typeof body.width === "number" && typeof body.height === "number" ? { width: body.width, height: body.height } : null);
      setDirty(false);
      setFeedback({ kind: "success", text: "Wireframe attached. It controls layout only; the style controls appearance." });
    } catch {
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to upload the wireframe" });
    } finally {
      setBusy(null);
      if (wireframeInputRef.current) wireframeInputRef.current.value = "";
    }
  };

  const previewPlan = async () => {
    if (busy !== null || !selectedModel || selectedReferenceIds.length === 0) return;
    setBusy("plan");
    setPlan(null);
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/screens/${screen.id}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, model: modelId, size, quality, count, referenceIds: selectedReferenceIds }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "PLAN_FAILED"}: ${body.error?.message ?? "Unable to resolve the generation plan"}` });
        return;
      }
      setPlan(body.plan as Plan);
      setPlanOpen(true);
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to resolve the generation plan" });
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!plan || generating) return;
    setGenerating(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/game-ui/screens/${screen.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: revision,
          model: modelId,
          size,
          quality,
          count,
          referenceIds: selectedReferenceIds,
          costMode: "strict_1000",
          requestId: newId(),
          // Consent is the hash the plan route returned; nothing is renewed here.
          consent: { planHash: plan.planHash },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPlanOpen(false);
        setPlan(null);
        setFeedback({ kind: "error", text: `${body.error?.code ?? "SUBMIT_FAILED"}: ${body.error?.message ?? "Unable to start generation"}` });
        return;
      }
      const parsed = AiJobSchema.safeParse(body.job);
      if (parsed.success) addJob(parsed.data);
      setPlanOpen(false);
      setComposerOpen(false);
      setFeedback({ kind: "success", text: "Generation started. The result appears in the gallery below when it finishes." });
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to start generation" });
    } finally {
      setGenerating(false);
    }
  };

  /** A finished job has written its render rows; the gallery is the only place that shows them. */
  const refreshRenders = useCallback(async () => {
    const response = await fetch(`/api/game-ui/screens/${screen.id}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.renders)) return;
    const fresh = body.renders as GameUiRenderSummary[];
    setRenders((current) => [...fresh, ...current.filter((render) => !fresh.some((entry) => entry.id === render.id))]);
    setRendersCursor(typeof body.nextCursor === "string" ? body.nextCursor : null);
  }, [screen.id]);

  useEffect(() => {
    const wasRunning = previousActiveJobIds.current.length > 0;
    previousActiveJobIds.current = activeJobIds;
    // Only the transition from running to settled is a reason to reload the gallery.
    if (wasRunning && activeJobIds.length === 0) void refreshRenders();
  }, [activeJobIds, refreshRenders]);

  const loadMoreRenders = async () => {
    if (!rendersCursor || busy !== null) return;
    setBusy("renders");
    try {
      const response = await fetch(`/api/game-ui/screens/${screen.id}?cursor=${encodeURIComponent(rendersCursor)}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ kind: "error", text: `${body.error?.code ?? "LOAD_FAILED"}: ${body.error?.message ?? "Unable to load more renders"}` });
        return;
      }
      const page = Array.isArray(body.renders) ? (body.renders as GameUiRenderSummary[]) : [];
      setRenders((current) => [...current, ...page.filter((render) => !current.some((entry) => entry.id === render.id))]);
      setRendersCursor(typeof body.nextCursor === "string" ? body.nextCursor : null);
    } catch {
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to load more renders" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-24 xl:pb-0">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-8 sm:py-8">
        <header className="flex flex-wrap items-center gap-3">
          <Link href={`/game-ui/${styleId}?tab=screens`} className="text-sm text-muted-foreground hover:text-foreground">Screens</Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="min-w-0 truncate text-lg font-semibold">{name || screen.name}</h1>
          <Badge variant="secondary">Revision {revision}</Badge>
          {dirty && <span role="status" className="text-xs text-warning">Unsaved draft edits.</span>}
        </header>

        {feedback && (
          <Alert variant={feedback.kind === "error" ? "destructive" : "default"} role="alert" className="px-3 py-2">
            <AlertDescription className={feedback.kind === "error" ? "text-sm" : "text-sm text-success"}>{feedback.text}</AlertDescription>
          </Alert>
        )}
        {status && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{status}</p>}

        <Card className="gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Screen draft</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Describe the screen, attach the layout it must follow and list the elements it has to contain.
              </p>
            </div>
            <Button type="button" onClick={() => void saveDraft()} disabled={busy !== null}>
              {busy === "save" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Save draft
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="screen-name" className="text-xs font-medium text-muted-foreground">Screen name</Label>
              <Input id="screen-name" value={name} maxLength={100} onChange={(event) => { setName(event.target.value); setDirty(true); }} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="screen-description" className="text-xs font-medium text-muted-foreground">Description</Label>
              <Input id="screen-description" value={description} maxLength={2000} placeholder="What the screen is for" onChange={(event) => { setDescription(event.target.value); setDirty(true); }} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="screen-layout-notes" className="text-xs font-medium text-muted-foreground">Layout notes</Label>
            <Textarea id="screen-layout-notes" value={layoutNotes} maxLength={2000} className="min-h-20" placeholder="Where each element sits" onChange={(event) => { setLayoutNotes(event.target.value); setDirty(true); }} />
          </div>
          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">Wireframe</p>
                <p className="text-xs text-muted-foreground">
                  One PNG, JPEG or WebP up to 5 MB. It controls layout; the style references control appearance. Attaching one
                  saves the draft as it is now.
                </p>
              </div>
              {wireframeVersionId && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setWireframeVersionId(null); setWireframeUrl(null); setWireframeSize(null); setDirty(true); }}
                >
                  Remove wireframe
                </Button>
              )}
            </div>
            {wireframeUrl ? (
              <Image src={wireframeUrl} alt="Screen wireframe" width={640} height={360} sizes="(min-width:768px) 480px, 92vw" className="h-40 w-auto rounded border border-border bg-accent object-contain" />
            ) : (
              <p className="text-xs text-muted-foreground">{wireframeVersionId ? "The wireframe preview is unavailable." : "No wireframe attached: the screen is generated from the description alone."}</p>
            )}
            <input
              ref={wireframeInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload wireframe"
              className="block w-full text-sm text-muted-foreground file:mr-3 file:h-11 file:rounded-md file:border file:border-border file:bg-background file:px-4 file:text-sm file:font-medium"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadWireframe(file);
              }}
            />
          </div>
        </Card>

        <Card className="gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Required elements</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                One row per element the screen needs. Detection later reports where each one actually is.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void suggest()} disabled={busy !== null}>
                {busy === "suggest" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Suggesting…</> : <><Wand2 className="size-4" aria-hidden /> Suggest elements</>}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null || requirements.length >= 100}
                onClick={() => {
                  setRequirements((current) => [
                    ...current,
                    { id: newId(), kind: "button", custom_type: null, name: `Element ${current.length + 1}`, purpose: "", visible_text: null, visible_state: null, required: true },
                  ]);
                  setDirty(true);
                }}
              >
                <Plus className="size-4" aria-hidden /> Add element
              </Button>
            </div>
          </div>

          {suggestWarnings.length > 0 && (
            <Alert variant="default" role="status" className="px-3 py-2">
              <AlertDescription>
                <span className="text-xs font-medium">About the suggestion</span>
                <ul className="mt-1 space-y-1 text-xs text-warning">
                  {suggestWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {requirements.length === 0 ? (
            <p role="status" className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No required elements yet. Use Suggest elements or add the rows yourself.
            </p>
          ) : (
            <ul className="space-y-3">
              {requirements.map((requirement, index) => (
                <li key={requirement.id} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-start">
                    <div className="space-y-1">
                      <Label htmlFor={`requirement-kind-${index}`} className="text-xs font-medium text-muted-foreground">Kind</Label>
                      <Select
                        value={requirement.kind}
                        onValueChange={(value) => {
                          setRequirements((current) => current.map((entry, position) => (position === index ? { ...entry, kind: value as ScreenRequirement["kind"], custom_type: value === "custom" ? entry.custom_type ?? "" : null } : entry)));
                          setDirty(true);
                        }}
                      >
                        <SelectTrigger id={`requirement-kind-${index}`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>{ELEMENT_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">{KIND_DESCRIPTIONS[requirement.kind]}</p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`requirement-name-${index}`} className="text-xs font-medium text-muted-foreground">Name</Label>
                      <Input
                        id={`requirement-name-${index}`}
                        aria-label={`Requirement ${index + 1} name`}
                        value={requirement.name}
                        maxLength={100}
                        onChange={(event) => {
                          setRequirements((current) => current.map((entry, position) => (position === index ? { ...entry, name: event.target.value } : entry)));
                          setDirty(true);
                        }}
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`requirement-required-${index}`}
                          checked={requirement.required}
                          onCheckedChange={(checked) => {
                            setRequirements((current) => current.map((entry, position) => (position === index ? { ...entry, required: checked === true } : entry)));
                            setDirty(true);
                          }}
                        />
                        <Label htmlFor={`requirement-required-${index}`} className="text-xs">Required</Label>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove requirement ${index + 1}`}
                        disabled={busy !== null}
                        onClick={() => { setRequirements((current) => current.filter((_, position) => position !== index)); setDirty(true); }}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                    <Input
                      aria-label={`Requirement ${index + 1} purpose`}
                      placeholder="Purpose"
                      value={requirement.purpose}
                      maxLength={1000}
                      onChange={(event) => {
                        setRequirements((current) => current.map((entry, position) => (position === index ? { ...entry, purpose: event.target.value } : entry)));
                        setDirty(true);
                      }}
                    />
                    <Input
                      aria-label={`Requirement ${index + 1} visible text`}
                      placeholder="Visible text"
                      value={requirement.visible_text ?? ""}
                      maxLength={500}
                      onChange={(event) => {
                        setRequirements((current) => current.map((entry, position) => (position === index ? { ...entry, visible_text: event.target.value === "" ? null : event.target.value } : entry)));
                        setDirty(true);
                      }}
                    />
                    <Input
                      aria-label={`Requirement ${index + 1} visible state`}
                      placeholder="Visible state"
                      value={requirement.visible_state ?? ""}
                      maxLength={200}
                      onChange={(event) => {
                        setRequirements((current) => current.map((entry, position) => (position === index ? { ...entry, visible_state: event.target.value === "" ? null : event.target.value } : entry)));
                        setDirty(true);
                      }}
                    />
                    {requirement.kind === "custom" && (
                      <Input
                        aria-label={`Requirement ${index + 1} custom type`}
                        placeholder="Custom type"
                        value={requirement.custom_type ?? ""}
                        maxLength={100}
                        onChange={(event) => {
                          setRequirements((current) => current.map((entry, position) => (position === index ? { ...entry, custom_type: event.target.value } : entry)));
                          setDirty(true);
                        }}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Collapsible open={composerOpen} onOpenChange={setComposerOpen} className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="flex min-h-11 w-full items-center justify-start gap-2 rounded-xl px-5 text-sm font-medium">
              <ChevronDown className={cn("size-4 transition-transform", composerOpen && "rotate-180")} aria-hidden /> Generate a screen image
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 px-5 pb-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="screen-size" className="text-xs font-medium text-muted-foreground">Aspect ratio</Label>
                <Select value={size} onValueChange={setSize}>
                  <SelectTrigger id="screen-size" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{(selectedModel?.sizes ?? ["1024x1024"]).map((option) => <SelectItem key={option} value={option}>{sizeLabel(option)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="screen-count" className="text-xs font-medium text-muted-foreground">Images</Label>
                <Select value={String(count)} onValueChange={(value) => setCount(Number(value) as 1 | 2 | 3 | 4)}>
                  <SelectTrigger id="screen-count" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{[1, 2, 3, 4].filter((option) => option <= (selectedModel?.maxCount ?? 4)).map((option) => <SelectItem key={option} value={String(option)}>{option}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            {wireframeSize && (
              <p className={cn("text-xs", wireframeRatioWarning ? "text-warning" : "text-muted-foreground")}>
                Wireframe {wireframeSize.width}×{wireframeSize.height} · output {sizeLabel(size)}
                {wireframeRatioWarning ? " — the ratios differ, so the layout is kept approximately, not pixel for pixel." : ""}
              </p>
            )}
            <Collapsible open={modelsOpen} onOpenChange={setModelsOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="justify-start gap-2 px-0 text-xs text-muted-foreground">
                  <ChevronDown className={cn("size-3.5 transition-transform", modelsOpen && "rotate-180")} aria-hidden /> Model and quality
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="screen-model" className="text-xs font-medium text-muted-foreground">Model</Label>
                  <Select
                    value={modelId}
                    onValueChange={(value) => {
                      const next = models.find((model) => model.id === value);
                      if (!next) return;
                      setModelId(next.id);
                      setSize(next.sizes[0]);
                      setQuality(next.qualities[0]);
                    }}
                  >
                    <SelectTrigger id="screen-model" className="w-full"><SelectValue placeholder="Select a model" /></SelectTrigger>
                    <SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="screen-quality" className="text-xs font-medium text-muted-foreground">Quality</Label>
                  <Select value={quality} onValueChange={setQuality}>
                    <SelectTrigger id="screen-quality" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{(selectedModel?.qualities ?? ["auto"]).map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </CollapsibleContent>
            </Collapsible>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Style references sent</p>
              {references.length === 0 ? (
                <p className="text-xs text-warning">This style has no live reference images. Add some on the style page before generating.</p>
              ) : (
                <ul className="flex flex-wrap gap-3">
                  {references.map((reference) => {
                    const checked = selectedReferenceIds.includes(reference.id);
                    return (
                      <li key={reference.id} className="w-24 space-y-1">
                        <div className={cn("overflow-hidden rounded-lg border bg-accent", checked ? "border-primary" : "border-border opacity-60")}>
                          {reference.signed_url ? (
                            <Image src={reference.signed_url} alt="Style reference" width={96} height={96} sizes="96px" className="h-20 w-full object-cover" />
                          ) : (
                            <span className="flex h-20 items-center justify-center text-[10px] text-muted-foreground">No preview</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Checkbox
                            id={`reference-${reference.id}`}
                            checked={checked}
                            aria-label={`Send reference ${reference.id}`}
                            onCheckedChange={(next) => {
                              setSelectedReferenceIds((current) => (next === true ? [...current, reference.id] : current.filter((id) => id !== reference.id)));
                              setPlan(null);
                            }}
                          />
                          <Label htmlFor={`reference-${reference.id}`} className="text-[11px] text-muted-foreground">Send</Label>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <Button type="button" onClick={() => void previewPlan()} disabled={busy !== null || selectedReferenceIds.length === 0 || !selectedModel}>
              {busy === "plan" ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Preparing…</> : "Generate image"}
            </Button>
          </CollapsibleContent>
        </Collapsible>

        <Card className="gap-3 p-5">
          <div>
            <h2 className="text-lg font-semibold">Generated images</h2>
            <p className="mt-1 text-sm text-muted-foreground">Every result of this screen is kept; open one to review its elements and export assets.</p>
          </div>
          {renders.length === 0 ? (
            <p role="status" className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No images yet. Generate one from the draft above.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {renders.map((render) => (
                <li key={render.id}>
                  <Link href={`/game-ui/${styleId}/screens/${screen.id}/renders/${render.id}`} className="group block">
                    <Card className="gap-0 overflow-hidden p-0 transition-colors group-hover:border-primary/50">
                      {render.sourceUrl ? (
                        <Image src={render.sourceUrl} alt={`Generated screen ${render.id}`} width={640} height={360} sizes="(min-width:1024px) 30vw, 92vw" className="h-40 w-full bg-accent object-contain" />
                      ) : (
                        <span aria-hidden className="flex h-40 items-center justify-center bg-accent text-xs text-muted-foreground">Preview unavailable</span>
                      )}
                      <div className="space-y-2 p-4">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant={render.jobStatus === "succeeded" ? "default" : render.jobStatus === "failed" ? "destructive" : "secondary"}>
                            {JOB_STATUS_LABELS[render.jobStatus as keyof typeof JOB_STATUS_LABELS] ?? render.jobStatus}
                          </Badge>
                          <Badge variant="secondary">{render.width}×{render.height}</Badge>
                          {render.elementSetRevision !== null && <Badge variant="secondary">Map rev {render.elementSetRevision}</Badge>}
                          {render.outputCount > 0 && <Badge variant="secondary">{render.outputCount} output{render.outputCount === 1 ? "" : "s"}</Badge>}
                        </div>
                        {render.errorCode && <p className="text-xs text-warning">{jobErrorMessage(render.errorCode)}</p>}
                        <p className="text-xs text-muted-foreground">{formatDateTime(render.createdAt)}</p>
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {rendersCursor && (
            <Button type="button" variant="outline" className="w-fit" onClick={() => void loadMoreRenders()} disabled={busy !== null}>
              {busy === "renders" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Load more images
            </Button>
          )}
        </Card>

        <Card className="gap-3 p-5">
          <div>
            <h2 className="text-lg font-semibold">Generation jobs</h2>
            <p className="mt-1 text-sm text-muted-foreground">Live status of this style&apos;s generations, newest first.</p>
          </div>
          {jobs.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">No jobs yet.</p>
          ) : (
            <ul className="space-y-2">
              {[...jobs].reverse().map(({ job, result_urls: resultUrls }) => (
                <li key={job.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-accent">
                    {resultUrls[0] ? <Image src={resultUrls[0]} alt="" width={40} height={40} className="size-10 object-cover" /> : <Upload className="size-4 text-muted-foreground" aria-hidden />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{job.input.original_prompt ?? job.input.prompt}</p>
                    <p className="text-xs text-muted-foreground">
                      {JOB_STATUS_LABELS[job.status]}
                      {!isTerminalStatus(job.status) ? " — this list keeps updating." : ""}
                    </p>
                    {job.status === "failed" && <p className="text-xs text-warning">{job.error_message ?? jobErrorMessage(job.error_code)}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent showCloseButton={false} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirm generation</DialogTitle>
            <DialogDescription className="text-xs">Generation is billed by your provider for each image.</DialogDescription>
          </DialogHeader>
          {plan && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div><dt className="text-muted-foreground">Model</dt><dd className="truncate font-medium">{plan.effectiveModelId}</dd></div>
              <div><dt className="text-muted-foreground">Provider</dt><dd className="truncate font-medium">{plan.provider}</dd></div>
              <div><dt className="text-muted-foreground">Size</dt><dd className="font-medium">{sizeLabel(plan.size)}</dd></div>
              <div><dt className="text-muted-foreground">Images</dt><dd className="font-medium">{plan.count}</dd></div>
              <div className="col-span-2"><dt className="text-muted-foreground">References included</dt><dd className="font-medium">{plan.referenceIds.length} included, {plan.omittedReferenceIds.length} omitted</dd></div>
            </dl>
          )}
          {plan?.explanation && <p className="text-xs text-muted-foreground">{plan.explanation}</p>}
          {plan?.compiledPrompt && (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="h-11 w-full justify-start px-2 text-xs font-normal text-muted-foreground hover:text-foreground">Compiled prompt</Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-accent p-3 text-[11px]">{plan.compiledPrompt}</pre>
              </CollapsibleContent>
            </Collapsible>
          )}
          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={() => setPlanOpen(false)} disabled={generating}>Cancel</Button>
            <Button className="flex-1" onClick={() => void generate()} disabled={generating}>
              {generating ? <><LoaderCircle className="size-4 animate-spin" aria-hidden /> Starting…</> : "Confirm generation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
