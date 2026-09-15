"use client";

import {
  AlertTriangle,
  ChevronDown,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  Settings,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import ClarificationForm from "./ClarificationForm";
import SchemaEditor from "./SchemaEditor";
import { StudioDialog } from "./StudioDialog";
import StyleGroupComposer, { type ComposerReference } from "./StyleGroupComposer";
import type { AiJob, ProjectJobFeedItem } from "@/db/ai-jobs";
import type { ModelCatalogEntry } from "@/lib/ai/models";
import type { StyleClarificationQuestionSet } from "@/lib/style/clarification-questions";
import {
  getStyleSetupState,
  isAnalysisStale,
  parseConfirmedDefinition,
  type ConfirmedStyleDefinition,
  type StyleSetupState,
} from "@/lib/style/confirmed-definition";

const MAX_REFERENCES = 8;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
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
    checks: Array<{ id: string; label: string; status: string; detail: string }>;
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
  models,
  initialJobs,
}: {
  styleId: string;
  initialTab: WorkspaceTab;
  compose?: boolean;
  sourceVersionId?: string | null;
  models: ModelCatalogEntry[];
  initialJobs: ProjectJobFeedItem[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<StyleDetail | null>(null);
  const [gallery, setGallery] = useState<GalleryAsset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [dragging, setDragging] = useState(false);
  const [composerOpen, setComposerOpen] = useState(compose);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

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
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => { setNameDraft(detail?.name ?? ""); }, [detail?.name]);

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
    () => initialJobs.reduce<AiJob | null>(
      (latest, item) => (!latest || Date.parse(item.job.created_at) > Date.parse(latest.created_at) ? item.job : latest),
      null,
    ),
    [initialJobs],
  );
  const sourceVersion = useMemo(() => {
    if (!sourceVersionId) return null;
    const item = initialJobs.find(({ job }) => job.version_id === sourceVersionId);
    if (!item) return null;
    return {
      id: item.job.version_id as string,
      prompt: item.job.input.original_prompt ?? item.job.input.prompt ?? null,
      metadata: (item.job.style_generation ?? {}) as Record<string, unknown>,
    };
  }, [initialJobs, sourceVersionId]);
  const showComposer = composerOpen || (detail !== null && gallery.length === 0 && ready);

  const selectTab = (next: WorkspaceTab) => { setTab(next); setFeedback(null); };

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
    setBusy("upload");
    setFeedback(null);
    setStatus(`Uploading ${queued.length} reference image(s)…`);
    try {
      const form = new FormData();
      for (const file of queued) form.append("files", file);
      const response = await fetch(`/api/styles/${styleId}/references`, { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      await refresh({ silent: true });
      if (!response.ok) {
        setStatus("");
        setFeedback({
          kind: "error",
          text: `${problems.length ? `${problems.join(" ")} ` : ""}${body.error?.code ?? "UPLOAD_FAILED"}: ${body.error?.message ?? "Upload failed"}. Files that were already accepted are kept — check the list below.`,
        });
        return;
      }
      const count = Array.isArray(body.references) ? body.references.length : queued.length;
      setStatus(`Uploaded ${count} reference image(s).`);
      setFeedback({
        kind: problems.length ? "error" : "success",
        text: `${problems.length ? `${problems.join(" ")} ` : ""}${count} reference image(s) added. Run Analyze references when the set is complete.`,
      });
    } catch {
      await refresh({ silent: true });
      setStatus("");
      setFeedback({
        kind: "error",
        text: `${problems.length ? `${problems.join(" ")} ` : ""}NETWORK_ERROR: Upload failed. Files that were already accepted are kept — check the list below.`,
      });
    } finally {
      setBusy(null);
    }
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
    if (busy !== null) return;
    setBusy("delete");
    setStatus("Deleting this style…");
    try {
      const response = await fetch(`/api/styles/${styleId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDeleteOpen(false);
        setStatus("");
        setFeedback({ kind: "error", text: `${body.error?.code ?? "DELETE_FAILED"}: ${body.error?.message ?? "Unable to delete this style"}` });
        return;
      }
      router.push("/style");
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
      <div className="min-h-dvh bg-[var(--canvas)] p-6 text-[var(--text)]">
        <div className="mx-auto max-w-5xl" aria-busy="true">
          <p className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <LoaderCircle className="size-4 animate-spin text-[var(--accent)]" /> Loading the style workspace…
          </p>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="min-h-dvh bg-[var(--canvas)] p-6 text-[var(--text)]">
        <div className="mx-auto max-w-5xl space-y-4">
          <div role="alert" className="studio-card space-y-3 p-5 text-sm">
            <p className="flex items-center gap-2 font-medium text-[var(--danger)]">
              <AlertTriangle className="size-4" aria-hidden /> This style could not be loaded
            </p>
            <p className="text-[var(--muted)]">{loadError ?? "Unknown error"}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="studio-button-primary" onClick={() => void refresh()}>Try again</button>
              <Link href="/style" className="studio-button-secondary">Back to styles</Link>
            </div>
          </div>
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
        <p className="text-sm text-[var(--muted)]">
          Upload 1–8 PNG or JPEG images, up to 5 MB each. They define rendering, palette, lighting and materials — not the subjects you ask for later.
        </p>
      </div>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = [...event.dataTransfer.files];
          if (files.length) void upload(files);
        }}
        className={`studio-card flex flex-col items-center gap-3 border-dashed p-6 text-center ${dragging ? "border-[var(--accent)]" : ""}`}
      >
        <ImagePlus className="size-6 text-[var(--muted)]" aria-hidden />
        <p className="text-sm text-[var(--muted)]">
          {references.length === 0
            ? "No reference images yet. Drop files here or choose them from your device."
            : `${references.length} of ${MAX_REFERENCES} reference images. Drop more files here or choose them from your device.`}
        </p>
        <label className={`${references.length === 0 ? "studio-button-primary" : "studio-button-secondary"} cursor-pointer`}>
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
        <p className="text-xs text-[var(--muted)]">PNG or JPEG · 5 MB each · 8 images maximum</p>
      </div>

      {references.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {references.map((reference) => (
            <li key={reference.id} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {reference.signed_url
                ? <img src={reference.signed_url} alt="Style reference" className="aspect-square w-full object-cover" />
                : <span className="flex aspect-square items-center justify-center px-2 text-center text-xs text-[var(--muted)]">Preview unavailable</span>}
              <div className="flex items-center justify-between gap-2 p-2">
                <span className="truncate text-[11px] text-[var(--muted)]">
                  {reference.width && reference.height ? `${reference.width}×${reference.height}` : "Reference image"}
                </span>
                <button
                  type="button"
                  onClick={() => void removeReference(reference.id)}
                  disabled={busy !== null}
                  aria-label="Remove this reference image from the editable set"
                  className="studio-button-secondary shrink-0 px-3 text-xs"
                >
                  {busy === reference.id ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" aria-hidden />} Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="studio-card flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {analyzedAt ? `Analyzed ${new Date(analyzedAt).toLocaleString()}` : "Not analyzed yet"}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {analysisStale
              ? "The analysis does not match the current reference set. Analyze again before confirming."
              : "The analysis matches the current reference set."}
          </p>
        </div>
        <button type="button" onClick={() => void analyze()} disabled={references.length === 0 || busy !== null} className="studio-button-primary">
          {busy === "analyze" ? <><LoaderCircle className="size-4 animate-spin" /> Analyzing…</> : <><Wand2 className="size-4" aria-hidden /> Analyze references</>}
        </button>
      </div>

      {analyzedAt !== null && !analysisStale && (
        <button type="button" className="studio-button-secondary" onClick={() => selectTab("style")}>
          Review style
        </button>
      )}

      {missingConfirmedReferences.length > 0 && (
        <section className="studio-card space-y-2 p-4">
          <h3 className="studio-label">Used by the confirmed style</h3>
          <p className="text-sm text-[var(--muted)]">
            These reference images are no longer in the editable set, but images generated from the confirmed style still use them.
          </p>
          <ul className="space-y-1">
            {missingConfirmedReferences.map((reference) => (
              <li key={reference.id} className="break-all font-mono text-xs text-[var(--muted)]">{reference.id}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );

  const reviewScreen = (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Review style</h2>
        <p className="text-sm text-[var(--muted)]">These rules steer every image generated from this style. Confirm them to start generating.</p>
      </div>

      {candidateChanged && (
        <p role="status" className="studio-card flex items-start gap-2 p-3 text-sm text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          Changes are not used until you confirm the updated style.
        </p>
      )}
      {confirmed.invalid && (
        <p role="alert" className="studio-card flex items-start gap-2 p-3 text-sm text-[var(--danger)]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          The saved definition of this style could not be read. Analyze the references and confirm the style again.
        </p>
      )}

      {schema ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {summaryCards.map((card) => (
            <div key={card.label} className="studio-card p-4">
              <p className="studio-label">{card.label}</p>
              <p className="text-sm">{card.value ?? "Not specified"}</p>
            </div>
          ))}
          <div className="studio-card p-4">
            <p className="studio-label">Colours</p>
            {colors.length > 0 ? (
              <span className="flex flex-wrap items-center gap-2">
                {colors.map((hex) => (
                  <span key={hex} aria-label={hex} title={hex} className="inline-block size-5 rounded border border-[var(--border)]" style={{ backgroundColor: hex }} />
                ))}
              </span>
            ) : rawColorList.length > 0 ? (
              <p className="text-sm">{rawColorList.join(", ")}</p>
            ) : (
              <p className="text-sm">Not specified</p>
            )}
          </div>
          <div className="studio-card p-4">
            <p className="studio-label">Keep consistent</p>
            <p className="text-sm">{keepConsistent ?? "Not specified"}</p>
          </div>
          <div className="studio-card p-4">
            <p className="studio-label">Avoid</p>
            <p className="text-sm">{avoid ?? "Not specified"}</p>
          </div>
        </div>
      ) : (
        <p role="status" className="studio-card p-5 text-sm text-[var(--muted)]">
          No analysis yet. Add reference images and run Analyze references to see the detected style.
        </p>
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
          <button type="button" className="studio-button-primary" onClick={() => void analyze()} disabled={references.length === 0 || busy !== null}>
            {busy === "analyze" ? <><LoaderCircle className="size-4 animate-spin" /> Analyzing…</> : <><Wand2 className="size-4" aria-hidden /> Analyze references</>}
          </button>
        ) : ready && !candidateChanged ? (
          <button type="button" className="studio-button-primary" onClick={() => selectTab("images")}>Create images</button>
        ) : (
          <button type="button" className="studio-button-primary" onClick={() => void confirmStyle()} disabled={!canConfirm}>
            {busy === "confirm" ? <><LoaderCircle className="size-4 animate-spin" /> Confirming…</> : "Confirm style & continue"}
          </button>
        )}
      </div>

      <details className="studio-card p-4">
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <ChevronDown className="size-4" aria-hidden /> Advanced
        </summary>
        <div className="mt-4 space-y-5">
          <div>
            <p className="studio-label">Readiness diagnostics</p>
            {detail.operability ? (
              <ul className="space-y-1 text-xs text-[var(--muted)]">
                <li className="text-[var(--text)]">{detail.operability.grade} · {detail.operability.score}/100</li>
                {detail.operability.checks.map((check) => (
                  <li key={check.id}>{check.status}: {check.label} — {check.detail}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--muted)]">No readiness diagnostics recorded yet.</p>
            )}
          </div>

          {priorSchemaVersion && (
            <button type="button" className="studio-button-secondary" disabled={busy !== null} onClick={() => void rollbackSchema(priorSchemaVersion.schema)}>
              {busy === "rollback" ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" aria-hidden />} Rollback to previous version
            </button>
          )}

          {schema && (
            <div>
              <p className="studio-label">Edit the candidate style</p>
              <SchemaEditor styleId={styleId} schema={schema} onSaved={() => refresh({ silent: true })} />
            </div>
          )}

          {schema && (
            <details>
              <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--text)]">Raw style JSON</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-[var(--surface-hover)] p-4 text-xs text-[var(--muted)]">{JSON.stringify(schema, null, 2)}</pre>
            </details>
          )}
        </div>
      </details>
    </section>
  );

  const imagesScreen = (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Images</h2>
        <p className="text-sm text-[var(--muted)]">Images generated with this style. Every image keeps the confirmed definition it was made with.</p>
      </div>

      {!ready && (
        <div className="studio-card space-y-3 p-4">
          <p className="text-sm">
            This style is not confirmed yet. Image generation uses the confirmed definition, so finish the setup first.
          </p>
          <button type="button" className="studio-button-primary" onClick={() => selectTab("references")}>Continue setup</button>
        </div>
      )}

      {confirmed.definition && (
        <div className="studio-card flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="studio-label">Confirmed definition</p>
            <p className="text-sm">
              {confirmed.definition.reference_snapshot.length} reference image(s) · confirmed {new Date(confirmed.definition.confirmed_at).toLocaleString()}
            </p>
          </div>
          {candidateChanged && (
            <p role="status" className="text-xs text-[var(--warning)]">Changes are not used until you confirm the updated style.</p>
          )}
          {candidateChanged && (
            <button type="button" className="studio-button-secondary" onClick={() => selectTab("style")}>Review the change</button>
          )}
        </div>
      )}

      {gallery.length > 0 ? (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {gallery.map((asset) => (
            <li key={asset.id}>
              <Link href={`/style/${styleId}/assets/${asset.id}`} className="group block overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] transition hover:border-[var(--accent)]">
                {asset.signedUrl
                  ? <img src={asset.signedUrl} alt={asset.name} className="aspect-square w-full object-cover" />
                  : <span className="flex aspect-square items-center justify-center text-xs text-[var(--muted)]">Preview unavailable</span>}
                <span className="block truncate px-3 py-2 text-xs text-[var(--muted)]">{asset.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="studio-card p-5 text-sm text-[var(--muted)]">
          {ready ? "No images yet. Create the first image for this style." : "No images yet."}
        </p>
      )}

      {ready && modelsForComposer.length === 0 && (
        <div className="studio-card space-y-3 p-4">
          <p className="text-sm">No image model is configured for this workspace yet, so this style cannot generate images.</p>
          <Link href="/settings" className="studio-button-primary">Set up a provider</Link>
        </div>
      )}

      {ready && showComposer && modelsForComposer.length > 0 && (
        <div className="space-y-4">
          {sourceVersionId && !sourceVersion && (
            <p role="status" className="studio-card p-3 text-sm text-[var(--muted)]">
              The image this link referred to could not be loaded, so this form creates a new image instead.
            </p>
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
            onSubmitted={() => { void refresh({ silent: true }); }}
          />
        </div>
      )}

      {ready && !showComposer && modelsForComposer.length > 0 && (
        <button type="button" className="studio-button-primary" onClick={() => setComposerOpen(true)}>
          <ImagePlus className="size-4" aria-hidden /> Create new image
        </button>
      )}
    </section>
  );

  return (
    <div className="min-h-dvh bg-[var(--canvas)] text-[var(--text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--panel)]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/style" className="text-sm text-[var(--muted)] hover:text-[var(--text)]">Styles</Link>
          <span aria-hidden className="text-[var(--muted)]">/</span>
          <h1 className="min-w-0 flex-1 truncate font-semibold">{detail.name}</h1>
          <span className={`rounded-full px-2 py-0.5 text-xs ${ready ? "bg-[var(--accent-subtle)] text-[var(--accent)]" : "bg-[var(--surface-hover)] text-[var(--muted)]"}`}>
            {ready ? "Confirmed" : "Setup in progress"}
          </span>
          <button type="button" className="studio-icon-button" aria-label="Style settings" onClick={() => setSettingsOpen(true)}>
            <Settings className="size-4" aria-hidden />
          </button>
        </div>
        <div className="mx-auto max-w-5xl px-4 pb-3 sm:px-6">
          {ready ? (
            <nav aria-label="Style sections" className="flex flex-wrap gap-1">
              {([["images", "Images"], ["style", "Style guide"], ["references", "References"]] as Array<[WorkspaceTab, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-current={tab === value ? "page" : undefined}
                  onClick={() => selectTab(value)}
                  className={`min-h-11 rounded-lg px-3 text-sm font-medium transition-colors ${tab === value ? "bg-[var(--accent-subtle)] text-[var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`}
                >
                  {label}
                </button>
              ))}
            </nav>
          ) : (
            <nav aria-label="Setup steps">
              <ol className="flex flex-wrap items-center gap-1">
                {SETUP_STEPS.map((step, index) => (
                  <li key={step.label}>
                    <button
                      type="button"
                      aria-current={setupStep === index ? "step" : undefined}
                      onClick={() => selectTab(step.tab)}
                      className={`min-h-11 rounded-lg px-3 text-sm font-medium transition-colors ${setupStep === index ? "bg-[var(--accent-subtle)] text-[var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"}`}
                    >
                      <span className="mr-1.5 text-xs">{index + 1}.</span>{step.label}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
        <p role="status" aria-live="polite" className="min-h-5 text-xs text-[var(--muted)]">{status}</p>

        {feedback && (
          <div
            role={feedback.kind === "error" ? "alert" : "status"}
            className={`studio-card flex flex-wrap items-center gap-3 p-3 text-sm ${feedback.kind === "error" ? "text-[var(--danger)]" : "text-[var(--success)]"}`}
          >
            <span className="min-w-0 flex-1">{feedback.text}</span>
            {feedback.action && (
              <button
                type="button"
                className="studio-button-secondary"
                onClick={() => {
                  const action = feedback.action;
                  setFeedback(null);
                  action?.run();
                }}
              >
                {feedback.action.label}
              </button>
            )}
          </div>
        )}

        {tab === "references" && referencesScreen}
        {tab === "style" && reviewScreen}
        {tab === "images" && imagesScreen}
      </main>

      <StudioDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} label="Style settings" className="studio-card w-full max-w-md p-6" style={{ position: "fixed" }}>
        <div className="space-y-5">
          <h2 className="font-semibold">Style settings</h2>
          <div>
            <label className="studio-label" htmlFor="style-name">Style name</label>
            <input id="style-name" className="studio-control" value={nameDraft} maxLength={100} onChange={(event) => setNameDraft(event.target.value)} />
            <button type="button" className="studio-button-secondary mt-3" disabled={busy !== null || !nameDraft.trim() || nameDraft.trim() === detail.name} onClick={() => void renameStyle()}>
              {busy === "rename" ? <LoaderCircle className="size-4 animate-spin" /> : null} Save name
            </button>
          </div>
          <div className="space-y-2 border-t border-[var(--border)] pt-4">
            <p className="text-sm font-medium text-[var(--danger)]">Delete this style</p>
            <p className="text-xs text-[var(--muted)]">Deleting removes the style and its reference images. Generated images are kept. This cannot be undone.</p>
            <button type="button" className="studio-button-danger" disabled={busy !== null} onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" aria-hidden /> Delete style
            </button>
          </div>
          <button type="button" className="studio-button-secondary w-full" onClick={() => setSettingsOpen(false)}>Close</button>
        </div>
      </StudioDialog>

      <StudioDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} label="Confirm deleting this style" className="studio-card w-full max-w-md p-6" style={{ position: "fixed" }}>
        <div className="space-y-4">
          <h2 className="font-semibold">Delete “{detail.name}”?</h2>
          <p className="text-sm text-[var(--muted)]">This deletes the style and its reference images. Already generated images stay in your workspace. This cannot be undone.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="studio-button-secondary flex-1" onClick={() => setDeleteOpen(false)} disabled={busy !== null}>Cancel</button>
            <button type="button" className="studio-button-danger flex-1" onClick={() => void deleteStyle()} disabled={busy !== null}>
              {busy === "delete" ? <LoaderCircle className="size-4 animate-spin" /> : null} Delete style
            </button>
          </div>
        </div>
      </StudioDialog>
    </div>
  );
}
