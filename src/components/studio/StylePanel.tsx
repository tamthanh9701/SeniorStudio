"use client";

import { LoaderCircle, Plus, Trash2, Upload, Wand2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type StyleListItem = { id: string; name: string; status: string; referenceCount: number; updatedAt: string };
type StyleReference = { id: string; signed_url: string | null; mime_type: string; byte_size: number; width: number | null; height: number | null; content_hash: string | null; created_at: string };
type StyleDetail = {
  id: string;
  name: string;
  status: string;
  schema: Record<string, unknown> | null;
  fingerprint: Record<string, unknown> | null;
  invariant_contract: Record<string, unknown> | null;
  analysis_meta: Record<string, unknown> | null;
  updated_at: string;
  references?: StyleReference[];
};

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

export default function StylePanel() {
  const [styles, setStyles] = useState<StyleListItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StyleDetail | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const [stylesLoading, setStylesLoading] = useState(true);
  const loadStyles = useCallback(async () => {
    try {
      const response = await fetch("/api/styles", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      setStyles(Array.isArray(body.styles) ? body.styles : []);
      return body.styles as StyleListItem[];
    } finally {
      setStylesLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (styleId: string) => {
    const response = await fetch(`/api/styles/${styleId}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json();
    setDetail(body.style ?? null);
    return body.style as StyleDetail;
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void loadStyles(); }, 0); return () => window.clearTimeout(timer); }, [loadStyles]);

  const expand = async (styleId: string) => {
    if (expandedId === styleId) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(styleId);
    setFeedback(null);
    await loadDetail(styleId);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy("create"); setFeedback(null);
    const response = await fetch("/api/styles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setNewName("");
      const created = body.style as StyleListItem;
      const current = await loadStyles();
      if (created && current) setExpandedId(created.id);
    } else {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create style"}` });
    }
    setBusy(null);
  };

  const uploadReferences = async (styleId: string, files: FileList) => {
    setBusy("upload"); setFeedback(null);
    const form = new FormData();
    for (const file of [...files]) form.append("files", file);
    const response = await fetch(`/api/styles/${styleId}/references`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setFeedback({ kind: "error", text: `${body.error?.code ?? "UPLOAD_FAILED"}: ${body.error?.message ?? "Upload failed"}` });
    await loadDetail(styleId);
    await loadStyles();
    setBusy(null);
  };

  const removeReference = async (styleId: string, referenceId: string) => {
    setBusy(referenceId); setFeedback(null);
    const response = await fetch(`/api/styles/${styleId}/references/${referenceId}`, { method: "DELETE" });
    if (!response.ok) setFeedback({ kind: "error", text: "Unable to remove reference." });
    await loadDetail(styleId);
    await loadStyles();
    setBusy(null);
  };

  const analyze = async (styleId: string) => {
    setBusy("analyze"); setFeedback(null);
    const response = await fetch(`/api/styles/${styleId}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "STYLE_ANALYSIS_FAILED"}: ${body.error?.message ?? "Analysis failed; references kept"}` });
    }
    await loadDetail(styleId);
    await loadStyles();
    setBusy(null);
  };

  const activate = async (styleId: string) => {
    setBusy("activate"); setFeedback(null);
    const response = await fetch(`/api/styles/${styleId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setFeedback({ kind: "error", text: `${body.error?.code ?? "STYLE_NOT_READY"}: ${body.error?.message ?? "Unable to activate style"}` });
    }
    await loadDetail(styleId);
    await loadStyles();
    setBusy(null);
  };

  const remove = async (styleId: string) => {
    setBusy("remove"); setFeedback(null);
    const response = await fetch(`/api/styles/${styleId}`, { method: "DELETE" });
    if (!response.ok) setFeedback({ kind: "error", text: "Unable to delete style." });
    setExpandedId(null); setDetail(null);
    await loadStyles();
    setBusy(null);
  };

  const analyzed = Boolean(detail?.analysis_meta && (detail.analysis_meta as Record<string, unknown>).analyzedAt);

  return <div className="space-y-3">
    <div className="flex gap-2">
      <input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="New style name" aria-label="New style name" className="studio-control min-w-0 flex-1" />
      <button onClick={() => void create()} disabled={!newName.trim() || busy !== null} aria-label="Create style" className="studio-button-primary shrink-0">{busy === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}</button>
    </div>
    {feedback && <p role="alert" className={`text-sm ${feedback.kind === "error" ? "text-[#ff9b9b]" : "text-[#66d7ae]"}`}>{feedback.text}</p>}
    {stylesLoading && styles.length === 0 && <div aria-hidden className="space-y-2">
      <div className="h-16 animate-pulse rounded-xl bg-white/[0.04]" />
      <div className="h-16 animate-pulse rounded-xl bg-white/[0.04]" />
      <div className="h-16 animate-pulse rounded-xl bg-white/[0.04]" />
    </div>}
    {!stylesLoading && styles.length === 0 && <p className="rounded-xl border border-dashed border-white/15 p-4 text-center text-sm text-[#98a2b3]">No styles yet. Upload reference images to capture a reusable visual style.</p>}
    {styles.map((style) => {
      const expanded = expandedId === style.id;
      return <section key={style.id} className="rounded-2xl border border-white/10 bg-white/[0.025]">
        <button onClick={() => void expand(style.id)} aria-expanded={expanded} className="flex w-full items-center justify-between gap-3 p-4 text-left">
          <span className="min-w-0">
            <span className="flex items-center gap-2 font-medium"><span aria-hidden className={style.status === "active" ? "text-[#66d7ae]" : "text-[#667085]"}>{style.status === "active" ? "● Active" : "○ Draft"}</span><span className="truncate">{style.name}</span></span>
            <span className="mt-1 block text-xs text-[#667085]">{style.referenceCount}/8 refs · updated {new Date(style.updatedAt).toLocaleString()}</span>
          </span>
        </button>
        {expanded && (
          detail && detail.id === style.id ? <div className="space-y-3 border-t border-white/10 p-4">
            <div>
              <p className="studio-label">References ({detail.references?.length ?? 0}/8)</p>
              {(detail.references?.length ?? 0) > 0 && <ul className="mt-2 grid grid-cols-3 gap-2">
                {detail.references!.map((reference) => <li key={reference.id} className="group relative aspect-square overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
                  {reference.signed_url ? <img src={reference.signed_url} alt={`${detail.name} reference`} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center px-2 text-center text-[10px] text-[#667085]">Preview unavailable</span>}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1.5 py-1 text-[10px]">{reference.width ?? "?"}×{reference.height ?? "?"}</span>
                  <button onClick={() => void removeReference(style.id, reference.id)} disabled={busy !== null} aria-label={`Remove reference ${reference.id}`} className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md bg-black/70 text-white opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
                </li>)}
              </ul>}
              <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 p-2.5 text-xs text-[#98a2b3] hover:text-white">
                <Upload className="size-3.5" /> Add PNG/JPEG references (≤5 MB each)
                <input type="file" multiple accept="image/png,image/jpeg" className="sr-only" disabled={busy !== null} onChange={(event) => { if (event.target.files?.length) void uploadReferences(style.id, event.target.files); event.target.value = ""; }} />
              </label>
            </div>
            <button onClick={() => void analyze(style.id)} disabled={(detail.references?.length ?? 0) < 1 || busy !== null} className="studio-button-primary w-full">
              {busy === "analyze" ? <><LoaderCircle className="size-4 animate-spin" /> Analyzing style…</> : <><Wand2 className="size-4" /> Analyze style</>}
            </button>
            {analyzed && <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-[#98a2b3]">
              <p className="font-medium text-[#d0d5dd]">Detected style</p>
              {groupText(detail.schema, "artistic_style", ["medium", "rendering_style", "style_reference"]) && <p>Rendering: {groupText(detail.schema, "artistic_style", ["medium", "rendering_style", "style_reference"])}</p>}
              {(() => { const hexes = hexList(detail.schema); const raw = rawColors(detail.schema); return hexes.length > 0 || raw.length > 0 ? <span className="flex flex-wrap items-center gap-1.5">Palette: {hexes.length > 0 ? hexes.map((hex) => <span key={hex} aria-label={hex} title={hex} className="inline-block size-4 rounded border border-white/20" style={{ backgroundColor: hex }} />) : <span>{raw.join(", ")}</span>}</span> : null; })()}
              {groupText(detail.schema, "lighting", ["primary_light_source", "light_quality"]) && <p>Lighting: {groupText(detail.schema, "lighting", ["primary_light_source", "light_quality"])}</p>}
              {groupText(detail.schema, "material_texture", ["primary_material", "surface_finish"]) && <p>Material: {groupText(detail.schema, "material_texture", ["primary_material", "surface_finish"])}</p>}
              {groupText(detail.schema, "mood_atmosphere", ["overall_mood", "emotional_tone"]) && <p>Mood: {groupText(detail.schema, "mood_atmosphere", ["overall_mood", "emotional_tone"])}</p>}
              {contractText(detail.invariant_contract, "forbidden_elements") && <p>Drift guard: {contractText(detail.invariant_contract, "forbidden_elements")}</p>}
            </div>}
            <div className="flex gap-2">
              <button onClick={() => void activate(style.id)} disabled={!analyzed || busy !== null || detail.status === "active"} className="studio-button-primary flex-1">{busy === "activate" ? <LoaderCircle className="size-4 animate-spin" /> : detail.status === "active" ? "Active" : "Activate"}</button>
              <button onClick={() => void remove(style.id)} disabled={busy !== null} className="studio-button-danger shrink-0" aria-label={`Delete style ${style.name}`}><Trash2 className="size-4" /></button>
            </div>
          </div> : <div className="border-t border-white/10 p-4 text-sm text-[#98a2b3]"><LoaderCircle className="mr-2 inline size-4 animate-spin" />Loading…</div>
        )}
      </section>;
    })}
  </div>;
}
