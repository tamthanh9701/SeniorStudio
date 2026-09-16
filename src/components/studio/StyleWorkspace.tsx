"use client";

import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  MoreHorizontal,
  Search,
  Settings,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ClarificationForm from "./ClarificationForm";
import JobTimeline from "./JobTimeline";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import SchemaEditor from "./SchemaEditor";
import StyleGroupComposer, { type ComposerReference } from "./StyleGroupComposer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatDateTime, vnDayKey } from "@/lib/format/datetime";
import { useTodayKey } from "@/lib/format/use-today-key";
import { isTerminalStatus, type AiJob, type ProjectJobFeedItem } from "@/db/ai-jobs";
import { MAX_REFERENCE_BYTES, MAX_STYLE_REFERENCES } from "@/lib/style/reference-limits";
import { useModuleJobs } from "@/lib/ai/use-module-jobs";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { StyleClarificationQuestionSet } from "@/lib/style/clarification-questions";
import {
  getStyleSetupState,
  isAnalysisStale,
  parseConfirmedDefinition,
  type ConfirmedStyleDefinition,
  type StyleSetupState,
} from "@/lib/style/confirmed-definition";

const MAX_REFERENCES = MAX_STYLE_REFERENCES;
const MAX_FILE_BYTES = MAX_REFERENCE_BYTES;
// The upload route accepts 20 MB per request; more files than that go in
// several requests because one oversized body would be rejected outright.
const MAX_UPLOAD_BATCH_FILES = 4;
const MAX_UPLOAD_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_GALLERY_ASSETS = 50;

export type WorkspaceTab = "images" | "references" | "style";

type StyleReferenceRow = {
  id: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  content_hash: string | null;
  created_at: string;
  signed_url: string | null;
};

type StyleDetail = {
  id: string;
  name: string;
  status: string;
  schema: Record<string, unknown> | null;
  invariant_contract: Record<string, unknown> | null;
  analysis_meta: Record<string, unknown> | null;
  confirmed_definition: unknown;
  clarification_questions?: StyleClarificationQuestionSet | null;
  operability?: {
    score: number;
    grade: "production_ready" | "usable_with_warnings" | "not_ready";
    /** Absent on rows written before the scorer recorded per-check detail. */
    checks?: Array<{ id: string; label: string; status: string; detail: string }>;
  } | null;
  updated_at: string;
  references: StyleReferenceRow[];
  schemaVersions?: Array<{ id: string; schema: Record<string, unknown>; source: string; created_at: string }>;
};

type GalleryAsset = {
  id: string;
  name: string;
  currentVersionId: string | null;
  signedUrl: string | null;
  createdAt: string;
  /** An edit of the current version that is waiting for Keep or Discard. */
  pendingVersionId?: string | null;
  /** The instruction the user wrote for this image. */
  originalPrompt?: string | null;
};

type Feedback = { kind: "error" | "success"; text: string; action?: { label: string; run: () => void } };

/** Stepper position: references → review style → generate. */
const STEP_FOR_STATE: Record<StyleSetupState, number> = {
  references: 0,
  analysis: 0,
  review: 1,
  ready: 2,
};

const SETUP_STEPS: Array<{ label: string; tab: WorkspaceTab }> = [
  { label: "References", tab: "references" },
  { label: "Review style", tab: "style" },
  { label: "Generate", tab: "images" },
];

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function groupText(schema: Record<string, unknown> | null, group: string, keys: string[]): string | null {
  if (!schema) return null;
  const entry = schema[group];
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  return keys.map((key) => asText(record[key])).filter(Boolean).join("; ") || null;
}

function hexList(schema: Record<string, unknown> | null): string[] {
  const entry = schema?.color_palette;
  const colors = entry && typeof entry === "object" ? (entry as Record<string, unknown>).dominant_colors : null;
  if (!Array.isArray(colors)) return [];
  return colors.filter((color): color is string => typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)).slice(0, 8);
}

function rawColors(schema: Record<string, unknown> | null): string[] {
  const entry = schema?.color_palette;
  const colors = entry && typeof entry === "object" ? (entry as Record<string, unknown>).dominant_colors : null;
  if (!Array.isArray(colors)) return [];
  return colors.filter((color): color is string => typeof color === "string" && color.trim().length > 0).slice(0, 8).map((color) => color.trim());
}

function contractText(contract: Record<string, unknown> | null, key: string): string | null {
  if (!contract) return null;
  const values = contract[key];
  return Array.isArray(values) && values.length
    ? values.filter((item): item is string => typeof item === "string").slice(0, 6).join("; ")
    : null;
}

/** Order-insensitive structural comparison of a candidate schema with a confirmed snapshot. */
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

function readConfirmed(value: unknown): { definition: ConfirmedStyleDefinition | null; invalid: boolean } {
  if (value === null || value === undefined) return { definition: null, invalid: false };
  try {
    return { definition: parseConfirmedDefinition(value), invalid: false };
  } catch {
    return { definition: null, invalid: true };
  }
}

function missingForConfirm(liveReferences: number, stale: boolean, analyzed: boolean): string {
  if (liveReferences === 0) return "add at least one reference image";
  if (!analyzed) return "run Analyze references";
  if (stale) return "the references changed since the analysis, so analyze them again";
  return "review the readiness diagnostics under Advanced";
}

export default function StyleWorkspace({
  styleId,
  initialTab,
  compose = false,
  sourceVersionId = null,
  initialSourceVersion = null,
  sourceAssetName = null,
  models,
  initialJobs,
  initialDetail,
  initialGallery,
}: {
  styleId: string;
  initialTab: WorkspaceTab;
  compose?: boolean;
  sourceVersionId?: string | null;
  /** Resolved by the server so a variant works for any version of this style. */
  initialSourceVersion?: { id: string; prompt: string | null; metadata: Record<string, unknown> } | null;
  /** Name of the image a variation starts from, shown on the composer. */
  sourceAssetName?: string | null;
  models: ModelCatalogEntry[];
  initialJobs: ProjectJobFeedItem[];
  /** Supplied by the server so the first paint shows the style, not a skeleton. */
  initialDetail?: StyleDetail;
  initialGallery?: GalleryAsset[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [loading, setLoading] = useState(initialDetail === undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<StyleDetail | null>(initialDetail ?? null);
  const [gallery, setGallery] = useState<GalleryAsset[]>(initialGallery ?? []);
  // When the server rendered this style there is nothing to fetch on mount.
  const serverRendered = useRef(initialDetail !== undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [dragging, setDragging] = useState(false);
  const [composerOpen, setComposerOpen] = useState(compose);
  const [imageQuery, setImageQuery] = useState("");
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null);
  const [deleteImageTarget, setDeleteImageTarget] = useState<GalleryAsset | null>(null);
  const [renameTarget, setRenameTarget] = useState<GalleryAsset | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // The feed is live: the worker updates rows while the user watches, and the
  // server-rendered jobs only seed it.
  const { items: jobs, addJob } = useModuleJobs({ module: "style", styleId }, initialJobs);
  const todayKey = useTodayKey();
  const activeJobIds = useMemo(() => jobs.filter(({ job }) => !isTerminalStatus(job.status)).map(({ job }) => job.id), [jobs]);
  const previousActiveJobIds = useRef(activeJobIds);

  const load = useCallback(async () => {
    const [detailResponse, galleryResponse] = await Promise.all([
      fetch(`/api/styles/${styleId}`, { cache: "no-store" }),
      fetch(`/api/styles/${styleId}/assets?limit=${MAX_GALLERY_ASSETS}`, { cache: "no-store" }),
    ]);
    const detailBody = await detailResponse.json().catch(() => ({}));
    if (!detailResponse.ok || !detailBody.style) {
      throw new Error(`${detailBody.error?.code ?? "LOAD_FAILED"}: ${detailBody.error?.message ?? "Unable to load this style"}`);
    }
    const galleryBody = galleryResponse.ok ? await galleryResponse.json().catch(() => ({})) : {};
    return {
      detail: detailBody.style as StyleDetail,
      gallery: Array.isArray(galleryBody.assets) ? (galleryBody.assets as GalleryAsset[]) : [],
    };
  }, [styleId]);

  const refresh = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      const result = await load();
      setDetail(result.detail);
      setGallery(result.gallery);
      setLoadError(null);
      return result.detail;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load this style");
      return null;
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    const wasRunning = previousActiveJobIds.current.length > 0;
    previousActiveJobIds.current = activeJobIds;
    if (wasRunning && activeJobIds.length === 0) void refresh({ silent: true });
  }, [activeJobIds, refresh]);

  useEffect(() => {
    // Server-rendered styles load nothing on mount; callers reload explicitly
    // after a mutation.
    if (serverRendered.current) return;
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  // Adjusting during render keeps the server's rename in the same commit, while a
  // draft the user is typing (detail.name unchanged) is left alone.
  const [nameSource, setNameSource] = useState(detail?.name ?? "");
  if ((detail?.name ?? "") !== nameSource) {
    setNameSource(detail?.name ?? "");
    setNameDraft(detail?.name ?? "");
  }


  const references = useMemo(() => detail?.references ?? [], [detail?.references]);
  const setupState: StyleSetupState = detail ? getStyleSetupState(detail, references.length) : "references";
  const analysisStale = detail ? isAnalysisStale(detail.analysis_meta, references) : true;
  const analyzedAt = typeof detail?.analysis_meta?.analyzedAt === "string" ? detail.analysis_meta.analyzedAt : null;
  const confirmed = useMemo(() => readConfirmed(detail?.confirmed_definition), [detail?.confirmed_definition]);
  const ready = setupState === "ready";
  const candidateChanged = confirmed.definition !== null
    && (analysisStale || !sameValue(detail?.schema ?? null, confirmed.definition.schema_snapshot));
  const missingConfirmedReferences = confirmed.definition
    ? confirmed.definition.reference_snapshot.filter((reference) => !references.some((live) => live.id === reference.id))
    : [];
  const modelsForComposer = useMemo(
    () => models.filter((model) => model.operations.includes("text_to_image") || model.operations.includes("image_to_image")),
    [models],
  );
  // Generation resolves the confirmed snapshot, so the composer must show that
  // set rather than the editable one whenever a definition exists.
  const composerReferences = useMemo<ComposerReference[]>(() => {
    if (!confirmed.definition) {
      return references.map((reference) => ({ id: reference.id, content_hash: reference.content_hash, signed_url: reference.signed_url }));
    }
    const signedUrls = new Map(references.map((reference) => [reference.id, reference.signed_url]));
    return confirmed.definition.reference_snapshot.map((reference) => ({
      id: reference.id,
      content_hash: reference.content_hash,
      signed_url: signedUrls.get(reference.id) ?? null,
    }));
  }, [confirmed.definition, references]);
  const latestJob: AiJob | null = useMemo(
    () => jobs.reduce<AiJob | null>(
      (latest, item) => (!latest || Date.parse(item.job.created_at) > Date.parse(latest.created_at) ? item.job : latest),
      null,
    ),
    [jobs],
  );
  const sourceVersion = useMemo(() => {
    if (!sourceVersionId) return null;
    const item = jobs.find(({ job }) => job.version_id === sourceVersionId);
    const fromJob = item
      ? { id: item.job.version_id as string, prompt: item.job.input.original_prompt ?? item.job.input.prompt ?? null, metadata: (item.job.style_generation ?? {}) as Record<string, unknown> }
      : null;
    if (!initialSourceVersion) return fromJob;
    // Prefer the server-resolved version; fall back to the job feed only when
    // that version predates the recorded original prompt.
    return {
      ...initialSourceVersion,
      prompt: initialSourceVersion.prompt ?? fromJob?.prompt ?? null,
    };
  }, [jobs, initialSourceVersion, sourceVersionId]);
  const showComposer = composerOpen || (detail !== null && gallery.length === 0 && ready);
  // Status the gallery and the activity panel share: a job that is still running
  // or that failed since the last successful image.
  const runningJobs = activeJobIds.length;
  const latestFailure = jobs.find(({ job }) => job.status === "failed") ?? null;
  // "Today" is the Vietnam calendar day, resolved after mount so the server and
  // the client cannot disagree about which jobs count.
  const succeededToday = todayKey === null ? 0 : jobs.filter(({ job }) => job.status === "succeeded" && vnDayKey(job.created_at) === todayKey).length;
  const failedToday = todayKey === null ? 0 : jobs.filter(({ job }) => (job.status === "failed" || job.status === "canceled") && vnDayKey(job.created_at) === todayKey).length;
  const runningAssetIds = new Set(
    jobs
      .filter(({ job }) => !isTerminalStatus(job.status))
      .map(({ job }) => job.asset_id)
      .filter((id): id is string => Boolean(id)),
  );
  const filteredGallery = imageQuery.trim()
    ? gallery.filter((asset) => {
        const needle = imageQuery.trim().toLowerCase();
        return asset.name.toLowerCase().includes(needle) || (asset.originalPrompt ?? "").toLowerCase().includes(needle);
      })
    : gallery;

  const selectTab = (next: WorkspaceTab) => { setTab(next); setFeedback(null); };

  const cancelJob = async (job: AiJob) => {
    const response = await fetch(`/api/ai-jobs/${job.id}/cancel`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "CANCEL_FAILED"}: ${body.error?.message ?? "Unable to cancel this job"}` });
      return;
    }
    await refresh({ silent: true });
    setFeedback({ kind: "success", text: "Generation canceled." });
  };

  const deleteImage = async (asset: GalleryAsset) => {
    setBusy("delete-image");
    setFeedback(null);
    const response = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    setBusy(null);
    if (!response.ok) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "DELETE_FAILED"}: ${body.error?.message ?? "Unable to delete this image"}` });
      return;
    }
    setDeleteImageTarget(null);
    await refresh({ silent: true });
    setFeedback({ kind: "success", text: "Image deleted." });
  };

  const renameImage = async () => {
    if (!renameTarget) return;
    const name = renameDraft.trim();
    if (!name) return;
    setBusy("rename-image");
    setFeedback(null);
    const response = await fetch(`/api/assets/${renameTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(null);
    if (!response.ok) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "RENAME_FAILED"}: ${body.error?.message ?? "Unable to rename this image"}` });
      return;
    }
    setRenameTarget(null);
    await refresh({ silent: true });
  };

  /** Keep a waiting edit: select it with the current version the user saw. */
  const keepPendingEdit = async (asset: GalleryAsset) => {
    if (!asset.pendingVersionId) return;
    setBusy("keep-edit");
    setFeedback(null);
    const response = await fetch(`/api/assets/${asset.id}/current`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId: asset.pendingVersionId, expectedCurrentVersionId: asset.currentVersionId }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(null);
    if (!response.ok) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "KEEP_FAILED"}: ${body.error?.message ?? "Unable to keep this edit"}` });
      await refresh({ silent: true });
      return;
    }
    await refresh({ silent: true });
    setFeedback({ kind: "success", text: "Edit kept. It is now the current version." });
  };

  /** Re-open the composer with the failed attempt's own words, ready to send. */
  const retryJob = (job: AiJob) => {
    setRetryPrompt(job.input.original_prompt ?? job.input.prompt ?? "");
    setComposerOpen(true);
    setActivityOpen(false);
    setFeedback({ kind: "success", text: "Your description is back in the form — review it and generate again." });
  };

  const upload = async (files: File[]) => {
    if (!detail || busy !== null || files.length === 0) return;
    const slots = MAX_REFERENCES - references.length;
    if (slots <= 0) {
      setFeedback({ kind: "error", text: `A style supports at most ${MAX_REFERENCES} reference images. Remove one before adding another.` });
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
      if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
        problems.push(`${file.name}: each reference must be 5 MB or smaller.`);
        continue;
      }
      valid.push(file);
    }
    const queued = valid.slice(0, slots);
    if (valid.length > queued.length) {
      problems.push(`${valid.length - queued.length} file(s) were not sent because this style already has ${references.length} reference images.`);
    }
    if (queued.length === 0) {
      setFeedback({ kind: "error", text: problems.join(" ") });
      return;
    }
    const batches: File[][] = [];
    let batch: File[] = [];
    let batchBytes = 0;
    for (const file of queued) {
      if (batch.length >= MAX_UPLOAD_BATCH_FILES || batchBytes + file.size > MAX_UPLOAD_BATCH_BYTES) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(file);
      batchBytes += file.size;
    }
    if (batch.length) batches.push(batch);

    setBusy("upload");
    setFeedback(null);
    // Batches go one after another: a rejected batch must not hide the files an
    // earlier batch already accepted.
    let accepted = 0;
    const failures: string[] = [];
    try {
      for (const [index, chunk] of batches.entries()) {
        setStatus(`Uploading ${queued.length} reference image(s) — batch ${index + 1} of ${batches.length}…`);
        const form = new FormData();
        for (const file of chunk) form.append("files", file);
        const response = await fetch(`/api/styles/${styleId}/references`, { method: "POST", body: form });
        const body = await response.json().catch(() => ({}));
        await refresh({ silent: true });
        if (!response.ok) {
          failures.push(`${body.error?.code ?? "UPLOAD_FAILED"}: ${body.error?.message ?? "Upload failed"}`);
          continue;
        }
        accepted += Array.isArray(body.references) ? body.references.length : chunk.length;
      }
    } catch {
      failures.push("NETWORK_ERROR: Upload failed");
      await refresh({ silent: true });
    }
    const notes = [...problems, ...failures];
    if (accepted === 0) {
      // A rejected request can still have stored part of its batch server-side,
      // so the list below — not this message — says what the style holds.
      setStatus("");
      setFeedback({ kind: "error", text: `${notes.join(" ")} Files that were already accepted are kept — check the list below.` });
      setBusy(null);
      return;
    }
    setStatus(`Uploaded ${accepted} reference image(s).`);
    setFeedback({
      kind: notes.length ? "error" : "success",
      text: `${notes.length ? `${notes.join(" ")} ` : ""}${accepted} reference image(s) added. Files that were already accepted are kept — run Analyze references when the set is complete.`,
    });
    setBusy(null);
  };

  const removeReference = async (referenceId: string) => {
    if (busy !== null) return;
    setBusy(referenceId);
    setStatus("Removing the reference from the editable set…");
    try {
      const response = await fetch(`/api/styles/${styleId}/references/${referenceId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      await refresh({ silent: true });
      if (!response.ok) {
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "DELETE_FAILED"}: ${body.error?.message ?? "Unable to remove this reference"}` });
        return;
      }
      setStatus("Reference removed.");
      setFeedback({ kind: "success", text: "Reference removed from the editable set. Analyze references again before you confirm the style." });
    } catch {
      await refresh({ silent: true });
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to remove this reference" });
    } finally {
      setBusy(null);
    }
  };

  const analyze = async () => {
    if (busy !== null || references.length === 0) return;
    setBusy("analyze");
    setFeedback(null);
    setStatus("Analyzing references — this can take up to a minute.");
    try {
      const response = await fetch(`/api/styles/${styleId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      await refresh({ silent: true });
      if (!response.ok) {
        setStatus("");
        setFeedback({
          kind: "error",
          text: `${body.error?.code ?? "STYLE_ANALYSIS_FAILED"}: ${body.error?.message ?? "Analysis failed"}. The reference images are kept.`,
          action: body.error?.code === "STYLE_ANALYSIS_STALE" ? { label: "Analyze references", run: analyze } : undefined,
        });
        return;
      }
      setStatus("Analysis finished.");
      setFeedback({ kind: "success", text: "Analysis finished. Review the detected style before you confirm it." });
      setTab("style");
    } catch {
      await refresh({ silent: true });
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Analysis failed. The reference images are kept." });
    } finally {
      setBusy(null);
    }
  };

  const confirmStyle = async () => {
    if (!detail || busy !== null) return;
    setBusy("confirm");
    setFeedback(null);
    setStatus("Confirming this style…");
    try {
      const response = await fetch(`/api/styles/${styleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active", expectedUpdatedAt: detail.updated_at }),
      });
      const body = await response.json().catch(() => ({}));
      await refresh({ silent: true });
      if (!response.ok) {
        const code = body.error?.code;
        setStatus("");
        if (code === "STYLE_ANALYSIS_STALE") {
          setFeedback({
            kind: "error",
            text: "The reference set changed after the analysis was run, so this style cannot be confirmed yet. Analyze references again, then review the result.",
            action: { label: "Analyze references", run: analyze },
          });
          return;
        }
        if (code === "STYLE_VERSION_CONFLICT") {
          setFeedback({ kind: "error", text: "This style changed since you opened it. The workspace was refreshed — review the current version and confirm it again." });
          return;
        }
        if (code === "STYLE_NOT_READY") {
          setFeedback({ kind: "error", text: `This style cannot be confirmed yet: ${missingForConfirm(references.length, analysisStale, analyzedAt !== null)}.` });
          return;
        }
        setFeedback({ kind: "error", text: `${code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to confirm this style"}` });
        return;
      }
      setStatus("Style confirmed.");
      setFeedback({ kind: "success", text: "Style confirmed. New images now generate from this definition." });
      setTab("images");
    } catch {
      await refresh({ silent: true });
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to confirm this style" });
    } finally {
      setBusy(null);
    }
  };

  const renameStyle = async () => {
    const name = nameDraft.trim();
    if (busy !== null || !name || name === detail?.name) return;
    setBusy("rename");
    setStatus("Saving the style name…");
    try {
      const response = await fetch(`/api/styles/${styleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => ({}));
      await refresh({ silent: true });
      if (!response.ok) {
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to save the style name"}` });
        return;
      }
      setStatus("Style name saved.");
    } catch {
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to save the style name" });
    } finally {
      setBusy(null);
    }
  };

  const rollbackSchema = async (schema: Record<string, unknown>) => {
    if (busy !== null) return;
    setBusy("rollback");
    setStatus("Restoring the previous schema version…");
    try {
      const response = await fetch(`/api/styles/${styleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema }),
      });
      const body = await response.json().catch(() => ({}));
      await refresh({ silent: true });
      if (!response.ok) {
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "UPDATE_FAILED"}: ${body.error?.message ?? "Unable to restore the previous schema"}` });
        return;
      }
      setStatus("Previous schema version restored.");
      setFeedback({ kind: "success", text: "Previous schema version restored. Review the style and confirm it again." });
    } catch {
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to restore the previous schema" });
    } finally {
      setBusy(null);
    }
  };

  const deleteStyle = async () => {
    if (busy !== null || !detail) return;
    const confirmedName = nameDraft.trim();
    if (confirmedName !== detail.name) {
      setFeedback({ kind: "error", text: "Type the style name exactly to confirm deletion" });
      return;
    }
    setBusy("delete");
    setStatus("Deleting this style…");
    try {
      const response = await fetch(`/api/styles/${styleId}?confirmName=${encodeURIComponent(confirmedName)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDeleteOpen(false);
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "DELETE_FAILED"}: ${body.error?.message ?? "Unable to delete this style"}` });
        return;
      }
      setDeleteOpen(false);
      // The workspace unmounts on navigation, so the confirmation travels as a
      // query parameter and the style list renders it.
      const deleted = (body.deleted ?? {}) as { images?: number; references?: number };
      const params = new URLSearchParams({ deleted: detail.name, images: String(deleted.images ?? 0), references: String(deleted.references ?? 0) });
      router.push(`/style?${params.toString()}`);
      router.refresh();
    } catch {
      setDeleteOpen(false);
      setStatus("");
      setFeedback({ kind: "error", text: "NETWORK_ERROR: Unable to delete this style" });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !detail) {
    return (
      <div className="min-h-dvh bg-background p-6 text-foreground">
        <div className="mx-auto max-w-6xl" aria-busy="true">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin text-primary" /> Loading the style workspace…
          </p>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="min-h-dvh bg-background p-6 text-foreground">
        <div className="mx-auto max-w-6xl space-y-4">
          <Alert variant="destructive" className="flex flex-col items-start gap-3 p-5 text-sm">
            <p className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="size-4" aria-hidden /> This style could not be loaded
            </p>
            <p className="text-muted-foreground">{loadError ?? "Unknown error"}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void refresh()}>Try again</Button>
              <Button asChild variant="outline"><Link href="/style">Back to styles</Link></Button>
            </div>
          </Alert>
        </div>
      </div>
    );
  }

  const schema = detail.schema;
  const colors = hexList(schema);
  const rawColorList = rawColors(schema);
  const summaryCards: Array<{ label: string; value: string | null }> = [
    { label: "Rendering", value: groupText(schema, "artistic_style", ["medium", "rendering_style", "style_reference"]) },
    { label: "Lighting", value: groupText(schema, "lighting", ["primary_light_source", "light_quality"]) },
    { label: "Material", value: groupText(schema, "material_texture", ["primary_material", "surface_finish"]) },
    { label: "Detail & mood", value: groupText(schema, "mood_atmosphere", ["overall_mood", "emotional_tone", "energy_level"]) },
  ];
  const keepConsistent = contractText(detail.invariant_contract, "must_match");
  const avoid = contractText(detail.invariant_contract, "forbidden_elements");
  const priorSchemaVersion = detail.schemaVersions && detail.schemaVersions.length > 1 ? detail.schemaVersions[1] : null;
  const canConfirm = references.length > 0 && analyzedAt !== null && !analysisStale && schema !== null && !busy;
  const setupStep = STEP_FOR_STATE[setupState];

  const referencesScreen = (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">References</h2>
        <p className="text-sm text-muted-foreground">
          Upload up to {MAX_REFERENCES} PNG or JPEG images, 5 MB each. They define rendering, palette, lighting and materials — not the subjects you ask for later.
        </p>
      </div>

      <Card
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = [...event.dataTransfer.files];
          if (files.length) void upload(files);
        }}
        className={cn("items-center gap-3 border-dashed p-6 text-center", dragging && "border-primary")}
      >
        <ImagePlus className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          {references.length === 0
            ? "No reference images yet. Drop files here or choose them from your device."
            : `${references.length} of ${MAX_REFERENCES} reference images. Drop more files here or choose them from your device.`}
        </p>
        <Button asChild variant={references.length === 0 ? "default" : "outline"}>
          <label className="cursor-pointer">
            <Upload className="size-4" aria-hidden /> Choose images
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg"
              className="sr-only"
              disabled={busy !== null}
              onChange={(event) => {
                const files = event.target.files ? [...event.target.files] : [];
                event.target.value = "";
                if (files.length) void upload(files);
              }}
            />
          </label>
        </Button>
        <p className="text-xs text-muted-foreground">PNG or JPEG · 5 MB each · {MAX_REFERENCES} images maximum</p>
      </Card>

      {references.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {references.map((reference) => (
            <li key={reference.id}>
              <Card className="gap-0 overflow-hidden p-0">
                {reference.signed_url
                  ? <Image src={reference.signed_url} alt="Style reference" width={512} height={512} sizes="(min-width:1024px) 22vw, (min-width:640px) 30vw, 45vw" className="aspect-square w-full object-cover" />
                  : <span className="flex aspect-square items-center justify-center px-2 text-center text-xs text-muted-foreground">Preview unavailable</span>}
                <div className="flex items-center justify-between gap-2 p-2">
                  <span className="truncate text-[11px] text-muted-foreground">
                    {reference.width && reference.height ? `${reference.width}×${reference.height}` : "Reference image"}
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void removeReference(reference.id)}
                    disabled={busy !== null}
                    aria-label="Remove this reference image from the editable set"
                    className="shrink-0 text-xs"
                  >
                    {busy === reference.id ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" aria-hidden />} Remove
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card className="gap-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {analyzedAt ? `Analyzed ${formatDateTime(analyzedAt)}` : "Not analyzed yet"}
            </p>
            {analysisStale ? (
              <Alert variant="destructive" className="mt-2 flex items-center gap-2 px-3 py-2 text-xs">
                <AlertTriangle className="size-4" aria-hidden />
                <span>The analysis does not match the current reference set. Analyze again before confirming.</span>
              </Alert>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">The analysis matches the current reference set.</p>
            )}
          </div>
          <Button type="button" onClick={() => void analyze()} disabled={references.length === 0 || busy !== null} className="w-full sm:w-auto">
            {busy === "analyze" ? <><LoaderCircle className="size-4 animate-spin" /> Analyzing…</> : <><Wand2 className="size-4" aria-hidden /> Analyze references</>}
          </Button>
        </div>
      </Card>

      {analyzedAt !== null && !analysisStale && (
        <Button type="button" variant="outline" onClick={() => selectTab("style")}>
          Review style
        </Button>
      )}

      {missingConfirmedReferences.length > 0 && (
        <Card className="gap-2 p-4">
          <Label className="text-xs font-semibold tracking-wide text-muted-foreground">Used by the confirmed style</Label>
          <p className="text-sm text-muted-foreground">
            These reference images are no longer in the editable set, but images generated from the confirmed style still use them.
          </p>
          <ul className="space-y-1">
            {missingConfirmedReferences.map((reference) => (
              <li key={reference.id} className="break-all font-mono text-xs text-muted-foreground">{reference.id}</li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );

  const reviewScreen = (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{ready ? "Style guide" : "Review style"}</h2>
        <p className="text-sm text-muted-foreground">
          {ready
            ? "These rules define how every image from this style is rendered. They change only when you confirm an update."
            : "These rules steer every image generated from this style. Confirm them to start generating."}
        </p>
      </div>

      {candidateChanged && (
        <Alert role="status" className="flex items-start gap-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          Changes are not used until you confirm the updated style.
        </Alert>
      )}
      {confirmed.invalid && (
        <Alert variant="destructive" className="flex items-start gap-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          The saved definition of this style could not be read. Analyze the references and confirm the style again.
        </Alert>
      )}

      {schema ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {summaryCards.map((card) => (
            <Card key={card.label} className="gap-2 p-4">
              <Label className="text-xs font-semibold tracking-wide text-muted-foreground">{card.label}</Label>
              <p className="text-sm">{card.value ?? "Not specified"}</p>
            </Card>
          ))}
          <Card className="gap-2 p-4">
            <Label className="text-xs font-semibold tracking-wide text-muted-foreground">Colours</Label>
            {colors.length > 0 ? (
              <span className="flex flex-wrap items-center gap-2">
                {colors.map((hex) => (
                  <span key={hex} aria-label={hex} title={hex} className="inline-block size-5 rounded border border-border" style={{ backgroundColor: hex }} />
                ))}
              </span>
            ) : rawColorList.length > 0 ? (
              <p className="text-sm">{rawColorList.join(", ")}</p>
            ) : (
              <p className="text-sm">Not specified</p>
            )}
          </Card>
          <Card className="gap-2 p-4">
            <Label className="text-xs font-semibold tracking-wide text-muted-foreground">Keep consistent</Label>
            <p className="text-sm">{keepConsistent ?? "Not specified"}</p>
          </Card>
          <Card className="gap-2 p-4">
            <Label className="text-xs font-semibold tracking-wide text-muted-foreground">Avoid</Label>
            <p className="text-sm">{avoid ?? "Not specified"}</p>
          </Card>
        </div>
      ) : (
        <Card role="status" className="p-5 text-sm text-muted-foreground">
          No analysis yet. Add reference images and run Analyze references to see the detected style.
        </Card>
      )}

      {detail.clarification_questions && detail.clarification_questions.questions.length > 0 && (
        <ClarificationForm
          styleId={styleId}
          expectedUpdatedAt={detail.updated_at}
          questions={detail.clarification_questions}
          onUpdated={() => refresh({ silent: true })}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {schema === null ? (
          <Button type="button" onClick={() => void analyze()} disabled={references.length === 0 || busy !== null}>
            {busy === "analyze" ? <><LoaderCircle className="size-4 animate-spin" /> Analyzing…</> : <><Wand2 className="size-4" aria-hidden /> Analyze references</>}
          </Button>
        ) : ready && !candidateChanged ? (
          <Button type="button" onClick={() => selectTab("images")}>Create images</Button>
        ) : (
          <Button type="button" onClick={() => void confirmStyle()} disabled={!canConfirm}>
            {busy === "confirm" ? <><LoaderCircle className="size-4 animate-spin" /> Confirming…</> : "Confirm style & continue"}
          </Button>
        )}
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="rounded-lg border border-border bg-card p-4">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="flex min-h-11 w-full items-center justify-start gap-2 text-sm font-medium">
            <ChevronDown className={cn("size-4 transition-transform", advancedOpen && "rotate-180")} aria-hidden /> Advanced
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4 space-y-5">
          <div>
            <Label className="text-xs font-semibold tracking-wide text-muted-foreground">Readiness diagnostics</Label>
            {detail.operability ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li className="text-foreground">{detail.operability.grade} · {detail.operability.score}/100</li>
                {(detail.operability.checks ?? []).map((check) => (
                  <li key={check.id}>{check.status}: {check.label} — {check.detail}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No readiness diagnostics recorded yet.</p>
            )}
          </div>

          {priorSchemaVersion && (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void rollbackSchema(priorSchemaVersion.schema)}>
              {busy === "rollback" ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" aria-hidden />} Rollback to previous version
            </Button>
          )}

          {schema && (
            <div>
              <Label className="text-xs font-semibold tracking-wide text-muted-foreground">Edit the candidate style</Label>
              <SchemaEditor styleId={styleId} schema={schema} onSaved={() => refresh({ silent: true })} />
            </div>
          )}

          {schema && (
            <Collapsible open={rawJsonOpen} onOpenChange={setRawJsonOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="flex min-h-11 items-center justify-start text-xs text-muted-foreground hover:text-foreground">Raw style JSON</Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-accent p-4 text-xs text-muted-foreground">{JSON.stringify(schema, null, 2)}</pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );

  const imagesScreen = (
    <section className="space-y-5">
      {!ready && (
        <Card className="gap-3 p-4">
          <p className="text-sm">
            This style is not confirmed yet. Image generation uses the confirmed definition, so finish the setup first.
          </p>
          <div>
            <Button type="button" onClick={() => selectTab("references")}>Continue setup</Button>
          </div>
        </Card>
      )}

      {ready && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {modelsForComposer.length > 0 && (
            <Button
              type="button"
              onClick={() => { setRetryPrompt(null); setComposerOpen(true); }}
              className="w-full sm:w-auto"
            >
              <ImagePlus className="size-4" aria-hidden /> Create image
            </Button>
          )}
          <div className="relative min-w-0 flex-1">
            <label className="sr-only" htmlFor="style-image-search">Search images</label>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="style-image-search"
              className="pl-9"
              placeholder="Search by name or description"
              value={imageQuery}
              onChange={(event) => setImageQuery(event.target.value)}
            />
          </div>
          {runningJobs > 0 && (
            <Badge variant="secondary" role="status" aria-live="polite" className="shrink-0 gap-1.5">
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              {runningJobs} running
            </Badge>
          )}
        </div>
      )}

      {ready && confirmed.definition && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {confirmed.definition.reference_snapshot.length} reference{confirmed.definition.reference_snapshot.length === 1 ? "" : "s"} · confirmed {formatDateTime(confirmed.definition.confirmed_at)} · revision {confirmed.definition.style_revision.slice(0, 8)}
          </span>
          <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={() => selectTab("style")}>
            Style guide
          </Button>
          {candidateChanged && <span role="status" className="text-warning">Changes are not used until you confirm the updated style.</span>}
        </div>
      )}

      {ready && modelsForComposer.length === 0 && (
        <Card className="items-start gap-3 p-4">
          <p className="text-sm">No image model is configured for this workspace yet, so this style cannot generate images.</p>
          <Button asChild><Link href="/settings">Set up a provider</Link></Button>
        </Card>
      )}

      {gallery.length > 0 ? (
        filteredGallery.length > 0 ? (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {filteredGallery.map((asset) => {
              const pending = Boolean(asset.pendingVersionId);
              const generating = runningAssetIds.has(asset.id);
              return (
                <li key={asset.id} className="group relative overflow-hidden rounded-lg border border-border bg-card transition hover:border-primary">
                  <Link href={`/style/${styleId}/assets/${asset.id}`} className="block">
                    {asset.signedUrl
                      ? <Image src={asset.signedUrl} alt={asset.name} width={512} height={512} sizes="(min-width:1024px) 22vw, (min-width:640px) 30vw, 45vw" className="aspect-square w-full object-cover" />
                      : <span className="flex aspect-square items-center justify-center text-xs text-muted-foreground">Preview unavailable</span>}
                    <span className="block px-3 pb-2 pr-10 pt-2">
                      <span className="block truncate text-xs font-medium text-foreground">{asset.name}</span>
                      {asset.originalPrompt && (
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={asset.originalPrompt}>{asset.originalPrompt}</span>
                      )}
                    </span>
                  </Link>
                  {generating && (
                    <Badge variant="secondary" className="absolute left-2 top-2 gap-1" role="status">
                      <LoaderCircle className="size-3 animate-spin" aria-hidden /> Generating
                    </Badge>
                  )}
                  {pending && (
                    <Badge className="absolute left-2 top-2 bg-warning/15 text-warning">Waiting for review</Badge>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1.5 bottom-1.5"
                        aria-label={`Actions for ${asset.name}`}
                      >
                        <MoreHorizontal className="size-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/style/${styleId}/assets/${asset.id}`}>Open</Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/style/${styleId}/assets/${asset.id}/edit`}>Edit</Link>
                      </DropdownMenuItem>
                      {asset.currentVersionId && (
                        <DropdownMenuItem asChild>
                          <Link href={`/style/${styleId}/new?sourceVersionId=${asset.currentVersionId}`}>Create variation</Link>
                        </DropdownMenuItem>
                      )}
                      {asset.pendingVersionId && (
                        <DropdownMenuItem asChild>
                          <Link href={`/style/${styleId}/assets/${asset.id}?version=${asset.pendingVersionId}&review=1`}>Review edit</Link>
                        </DropdownMenuItem>
                      )}
                      {asset.pendingVersionId && (
                        <DropdownMenuItem disabled={busy !== null} onSelect={() => void keepPendingEdit(asset)}>Keep edit</DropdownMenuItem>
                      )}
                      <DropdownMenuItem disabled={busy !== null} onSelect={() => { setRenameTarget(asset); setRenameDraft(asset.name); }}>
                        Rename
                      </DropdownMenuItem>
                      {asset.signedUrl && (
                        <DropdownMenuItem asChild>
                          <a href={asset.signedUrl} download>Download</a>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={busy !== null}
                        onSelect={() => setDeleteImageTarget(asset)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        ) : (
          <Card role="status" className="p-5 text-sm text-muted-foreground">
            No image matches “{imageQuery.trim()}”.
          </Card>
        )
      ) : (
        <Card role="status" className="p-5 text-sm text-muted-foreground">
          {ready ? "No images yet. Create the first image for this style." : "No images yet."}
        </Card>
      )}

      {jobs.length > 0 && (
        <Collapsible open={activityOpen} onOpenChange={setActivityOpen} className="rounded-lg border border-border">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between px-4">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Activity className="size-4" aria-hidden /> Activity
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {runningJobs > 0 ? `${runningJobs} running · ` : latestFailure ? "A generation failed · " : "All finished · "}
                {todayKey !== null && `today ${succeededToday} done / ${failedToday} failed`}
                <ChevronDown className={cn("size-4 transition", activityOpen && "rotate-180")} aria-hidden />
              </span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-border">
            <JobTimeline items={jobs} onRetry={retryJob} onCancel={(job) => void cancelJob(job)} onSelectResult={({ assetId }) => { if (assetId) router.push(`/style/${styleId}/assets/${assetId}`); }} />
          </CollapsibleContent>
        </Collapsible>
      )}

      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename image</DialogTitle>
            <DialogDescription>Give this image a name you recognise in the gallery.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="image-name" className="text-xs font-semibold">Name</Label>
            <Input
              id="image-name"
              value={renameDraft}
              maxLength={120}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void renameImage(); }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameTarget(null)} disabled={busy !== null}>Cancel</Button>
            <Button type="button" onClick={() => void renameImage()} disabled={!renameDraft.trim() || busy !== null}>
              {busy === "rename-image" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Save name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteImageTarget !== null} onOpenChange={(open) => { if (!open) setDeleteImageTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this image?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteImageTarget?.name} and every version of it are removed permanently. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete-image"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "delete-image"}
              onClick={(event) => { event.preventDefault(); if (deleteImageTarget) void deleteImage(deleteImageTarget); }}
            >
              {busy === "delete-image" ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {ready && showComposer && modelsForComposer.length > 0 && (
        <div className="space-y-4">
          {sourceVersionId && !sourceVersion && (
            <Card role="status" className="p-3 text-sm text-muted-foreground">
              The image this link referred to could not be loaded, so this form creates a new image instead.
            </Card>
          )}
          <StyleGroupComposer
            styleId={styleId}
            styleName={detail.name}
            models={modelsForComposer}
            references={composerReferences}
            confirmedRevision={confirmed.definition?.style_revision ?? null}
            sourceVersion={sourceVersion}
            embedded
            initialJob={latestJob}
            initialPrompt={retryPrompt}
            sourceLabel={sourceVersion ? sourceAssetName : null}
            onSubmitted={(job) => { addJob(job); setActivityOpen(true); }}
          />
        </div>
      )}
    </section>
  );

  return (
    <Tabs value={tab} onValueChange={(value) => selectTab(value as WorkspaceTab)} className="flex min-h-dvh flex-col gap-0 bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-muted">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/style" className="text-sm text-muted-foreground hover:text-foreground">Styles</Link>
          <span aria-hidden className="text-muted-foreground">/</span>
          <h1 className="min-w-0 flex-1 truncate font-semibold">{detail.name}</h1>
          <Badge variant={ready ? "default" : "secondary"}>
            {ready ? "Confirmed" : "Setup in progress"}
          </Badge>
          <Button type="button" variant="outline" size="icon" aria-label="Style settings" onClick={() => setSettingsOpen(true)}>
            <Settings className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-3 sm:px-6">
          {ready ? (
            <nav aria-label="Style sections">
              <TabsList variant="line" className="h-auto! flex flex-wrap gap-1 bg-transparent p-0">
                {([["images", "Images"], ["style", "Style guide"], ["references", "References"]] as Array<[WorkspaceTab, string]>).map(([value, label]) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    aria-current={tab === value ? "page" : undefined}
                    className="h-11 min-h-11 px-3 text-sm font-medium"
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </nav>
          ) : (
            <nav aria-label="Setup steps">
              <TabsList variant="line" className="h-auto! flex flex-wrap gap-1 bg-transparent p-0">
                {SETUP_STEPS.map((step, index) => (
                  <TabsTrigger
                    key={step.label}
                    value={step.tab}
                    aria-current={setupStep === index ? "step" : undefined}
                    className="h-11 min-h-11 px-3 text-sm font-medium"
                  >
                    <span className="mr-1.5 text-xs">{index + 1}.</span>{step.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </nav>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
        <p role="status" aria-live="polite" className="min-h-5 text-xs text-muted-foreground">{status}</p>

        {feedback && (
          <Alert
            role={feedback.kind === "error" ? "alert" : "status"}
            variant={feedback.kind === "error" ? "destructive" : "default"}
            className={cn("flex flex-wrap items-center gap-3 p-3 text-sm", feedback.kind === "error" ? "text-destructive" : "text-success")}
          >
            <span className="min-w-0 flex-1">{feedback.text}</span>
            {feedback.action && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const action = feedback.action;
                  setFeedback(null);
                  action?.run();
                }}
              >
                {feedback.action.label}
              </Button>
            )}
          </Alert>
        )}

        <TabsContent value="references">{referencesScreen}</TabsContent>
        <TabsContent value="style">{reviewScreen}</TabsContent>
        <TabsContent value="images">{imagesScreen}</TabsContent>
      </main>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="text-base font-semibold">Style settings</DialogTitle>
          <div className="space-y-5">
            <div>
              <Label htmlFor="style-name" className="text-xs font-semibold tracking-wide text-muted-foreground">Style name</Label>
              <Input id="style-name" value={nameDraft} maxLength={100} onChange={(event) => setNameDraft(event.target.value)} />
              <Button type="button" variant="outline" className="mt-3" disabled={busy !== null || !nameDraft.trim() || nameDraft.trim() === detail.name} onClick={() => void renameStyle()}>
                {busy === "rename" ? <LoaderCircle className="size-4 animate-spin" /> : null} Save name
              </Button>
            </div>
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-sm font-medium text-destructive">Delete this style</p>
              <p className="text-xs text-muted-foreground">This permanently deletes the style, its reference images and every image generated inside it. This cannot be undone.</p>
              <div>
                <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => { setNameDraft(""); setDeleteOpen(true); }}>
                  <Trash2 className="size-4" aria-hidden /> Delete style
                </Button>
              </div>
            </div>
            <Button type="button" variant="outline" className="w-full" onClick={() => setSettingsOpen(false)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setNameDraft(detail.name); }}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="text-base font-semibold">Delete “{detail.name}”?</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">This permanently deletes the style, its reference images and every image generated inside it.</DialogDescription>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm-name" className="text-xs font-semibold tracking-wide text-muted-foreground">Type the style name to confirm</Label>
            <Input id="delete-confirm-name" value={nameDraft} placeholder={detail.name} autoComplete="off" onChange={(event) => setNameDraft(event.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => { setDeleteOpen(false); setNameDraft(detail.name); }} disabled={busy !== null}>Cancel</Button>
            <Button type="button" variant="destructive" className="flex-1" onClick={() => void deleteStyle()} disabled={busy !== null || nameDraft.trim() !== detail.name}>
              {busy === "delete" ? <LoaderCircle className="size-4 animate-spin" /> : null} Delete style
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
