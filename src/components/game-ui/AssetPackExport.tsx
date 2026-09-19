"use client";

// Asset pack export is entirely client-side: the server pins which outputs may
// be exported and hands back time-limited URLs, and the browser verifies every
// byte before it writes the archive. A pack that fails verification yields no
// file at all, so a partial ZIP can never look like a finished export.

import { Download, LoaderCircle, X } from "lucide-react";
import { useMemo, useRef, useState, type JSX } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { isElementKind, kindLabel, COMPOSITE_KINDS, ORGANIZATIONAL_KINDS } from "@/lib/game-ui/taxonomy";
import { buildAssetZip } from "@/lib/game-ui/pack-client";

type PackOutput = {
  id: string;
  elementId: string;
  elementName: string;
  kind: string;
  mode: "exact" | "reconstructed";
  alphaStatus: "transparent" | "opaque";
  reviewStatus: "pending" | "accepted" | "discarded";
  reviewed: boolean;
  /**
   * Optional: the render page already knows the element tree. Without it the
   * overlap warning can only tell that a composite is selected, not which of its
   * children is selected alongside it.
   */
  parentId?: string | null;
  /** The element-map revision this output was extracted from. */
  elementSetId?: string | null;
};

type ExportFile = { outputId: string; path: string; url: string; byteSize: number; sha256: string };
type ExportResponse = { manifest: unknown; files: ExportFile[]; expiresAt?: string };

/** Why a row cannot be exported, or null when it can. */
function blockedReason(output: PackOutput, currentSetId: string): string | null {
  if (output.elementSetId != null && output.elementSetId !== currentSetId) {
    return "From an earlier map revision: extract the element again after changing its bounds.";
  }
  if (isElementKind(output.kind) && ORGANIZATIONAL_KINDS.includes(output.kind)) {
    return "Group elements only organize the screen: they have no pixels to export.";
  }
  if (output.alphaStatus !== "transparent") {
    return "Opaque output: the background was not removed, so it cannot join a transparent pack.";
  }
  if (!output.reviewed) {
    return "Not reviewed yet: review the element bounds before exporting it.";
  }
  if (output.reviewStatus === "pending") return "Pending your review: accept this output to export it.";
  if (output.reviewStatus === "discarded") return "Discarded: this output is no longer part of the pack.";
  if (output.reviewStatus !== "accepted") return "This output cannot be exported.";
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Composite parents export the pixels their children also cover. */
function overlapWarnings(outputs: PackOutput[], selected: Set<string>): string[] {
  const selectedRows = outputs.filter((output) => selected.has(output.id));
  const hasParentData = selectedRows.some((output) => output.parentId != null);
  const warnings: string[] = [];

  if (hasParentData) {
    const byElementId = new Map(selectedRows.map((output) => [output.elementId, output]));
    for (const row of selectedRows) {
      const parent = row.parentId === null || row.parentId === undefined ? undefined : byElementId.get(row.parentId);
      if (!parent) continue;
      warnings.push(
        `${row.elementName} sits inside ${parent.elementName}: both PNGs cover the same pixels and will overlap in the archive.`,
      );
    }
    return warnings;
  }

  // Without the element tree, warn for every selected composite: a bar carries a
  // track and fill, so its children overlap it whenever they are selected too.
  if (selectedRows.length < 2) return warnings;
  for (const row of selectedRows) {
    if (!isElementKind(row.kind) || !COMPOSITE_KINDS.includes(row.kind)) continue;
    warnings.push(`${row.elementName} is a composite: any child region selected in this pack overlaps it.`);
  }
  return warnings;
}

export default function AssetPackExport({
  renderId,
  elementSetId,
  outputs,
  onRefresh,
}: {
  renderId: string;
  elementSetId: string;
  outputs: PackOutput[];
  onRefresh: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(
    // Only what the server would accept is preselected: an output from an older
    // map revision fails the whole pack, so offering it by default is a trap.
    () => new Set(outputs.filter((output) => blockedReason(output, elementSetId) === null).map((output) => output.id)),
  );
  const [busy, setBusy] = useState<"pack" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ files: number; bytes: number } | null>(null);
  const [done, setDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const exportable = useMemo(() => outputs.filter((output) => blockedReason(output, elementSetId) === null), [outputs, elementSetId]);
  const warnings = useMemo(() => overlapWarnings(outputs, selected), [outputs, selected]);

  const toggle = (outputId: string) => {
    setDone(false);
    // The size estimate belongs to the previous selection.
    setEstimate(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(outputId)) next.delete(outputId);
      else next.add(outputId);
      return next;
    });
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
    setProgress(null);
    setDone(false);
  };

  const downloadPack = async () => {
    const outputIds = outputs.filter((output) => selected.has(output.id)).map((output) => output.id);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("pack");
    setError(null);
    setDone(false);
    setEstimate(null);
    setProgress(null);

    try {
      const response = await fetch(`/api/game-ui/renders/${renderId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elementSetId, outputIds }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as Partial<ExportResponse> & {
        error?: { code?: string; message?: string };
      };
      if (!response.ok) {
        setError(
          `${body.error?.code ?? "ASSET_PACK_NOT_READY"}: ${body.error?.message ?? "Unable to prepare this pack"}`,
        );
        return;
      }
      const files = body.files ?? [];
      // One signed file per selected output: anything else would mean the pack
      // silently omits part of the selection.
      if (files.length !== outputIds.length) {
        setError(`ASSET_PACK_NOT_READY: expected ${outputIds.length} files, received ${files.length}`);
        return;
      }
      setEstimate({ files: files.length, bytes: files.reduce((total, file) => total + file.byteSize, 0) });

      const verified: Array<{ path: string; bytes: Uint8Array<ArrayBuffer> }> = [];
      for (const [index, file] of files.entries()) {
        setProgress(`Verifying ${index + 1} of ${files.length}…`);
        const fileResponse = await fetch(file.url, { signal: controller.signal });
        if (!fileResponse.ok) {
          setError(`FILE_UNAVAILABLE: ${file.path} could not be downloaded`);
          return;
        }
        const bytes = new Uint8Array(await fileResponse.arrayBuffer());
        // The server hashed these bytes when the output was created: a mismatch
        // means the URL served something else, so nothing is written.
        if (bytes.byteLength !== file.byteSize || (await sha256Hex(bytes)) !== file.sha256.toLowerCase()) {
          setError(`FILE_UNAVAILABLE: ${file.path} did not match the pinned size and hash`);
          return;
        }
        verified.push({ path: file.path, bytes });
      }

      setProgress("Building the archive…");
      const archive = await buildAssetZip(verified, body.manifest);
      const url = URL.createObjectURL(new Blob([archive], { type: "application/zip" }));
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `game-ui-${renderId}.zip`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      setDone(true);
      onRefresh();
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "EXPORT_FAILED: Unable to build the pack");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <section className="space-y-3" aria-label="Asset pack export">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Export asset pack</h3>
        <p className="text-xs text-muted-foreground">
          Each accepted transparent output becomes a PNG with a pinned manifest. Files are verified against their recorded
          size and hash before the archive is written.
        </p>
      </div>

      {outputs.length === 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          No exported elements yet. Extract or reconstruct an element to include it in a pack.
        </p>
      ) : (
        <ul className="space-y-2">
          {outputs.map((output) => {
            const blocked = blockedReason(output, elementSetId);
            const checkboxId = `pack-output-${output.id}`;
            return (
              <li key={output.id} className="flex items-start gap-2">
                <Checkbox
                  id={checkboxId}
                  checked={selected.has(output.id)}
                  disabled={blocked !== null || busy !== null}
                  onCheckedChange={() => toggle(output.id)}
                  aria-label={`Include ${output.elementName} in the pack`}
                />
                <div className="min-w-0 text-xs">
                  <label htmlFor={checkboxId} className="font-medium">
                    {output.elementName}
                  </label>
                  <p className="text-muted-foreground">
                    {isElementKind(output.kind) ? kindLabel(output.kind, null) : output.kind} · {output.mode} ·{" "}
                    {output.alphaStatus} · {output.reviewStatus}
                  </p>
                  {blocked && (
                    <p className="text-warning" role="alert">
                      {blocked}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground" role="status">
        {selected.size} of {exportable.length} exportable elements selected.
        {estimate && ` Estimated ${formatBytes(estimate.bytes)} across ${estimate.files} ${estimate.files === 1 ? "file" : "files"}.`}
      </p>

      {warnings.map((warning) => (
        <p key={warning} className="text-xs text-warning" role="alert">
          {warning}
        </p>
      ))}

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
      {busy === "pack" && progress && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> {progress}
        </p>
      )}
      {done && (
        <Alert variant="default" role="status" aria-live="polite">
          <AlertDescription className="text-xs">
            <span className="flex items-center gap-2 text-success">
              <Download className="size-3.5" aria-hidden /> Pack downloaded with the pinned manifest.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={() => void downloadPack()}
          disabled={busy !== null || selected.size === 0}
          aria-label="Download ZIP pack"
        >
          {busy === "pack" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
          Download ZIP
        </Button>
        {busy === "pack" && (
          <Button type="button" variant="outline" onClick={cancel} aria-label="Cancel pack download">
            <X className="size-4" aria-hidden />
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}
