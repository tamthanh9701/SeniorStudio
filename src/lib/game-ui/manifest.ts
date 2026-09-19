// A downloaded pack describes itself through its manifest.json, so the manifest
// carries identifiers, geometry and hashes only. Storage paths, signed URLs and
// workspace identifiers stay server-side: the ZIP may be shared or archived.

import { GameUiError } from "./errors";

export const MANIFEST_VERSION = 1;

const SAFE_NAME_MAX = 40;
const SAFE_NAME_FALLBACK = "element";
const ASSET_ENTRY_PREFIX = "assets/";
// Element ids are server-assigned UUIDs; rejecting anything else keeps a caller's
// mistake from turning into a path that escapes the archive directory.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PackManifestInput = {
  style: { id: string; revision: string };
  screen: {
    id: string;
    renderId: string;
    sourceVersionId: string;
    width: number;
    height: number;
    spec: unknown;
  };
  elementSet: { id: string; revision: number };
  elements: Array<{
    id: string;
    parentId: string | null;
    kind: string;
    customType: string | null;
    name: string;
    purpose: string;
    visibleText: string | null;
    visibleState: string | null;
    bounds: { x: number; y: number; width: number; height: number };
    zIndex: number;
    occluded: boolean;
  }>;
  assets: Array<{
    elementId: string;
    outputId: string;
    assetId: string;
    versionId: string;
    path: string;
    mode: "exact" | "reconstructed";
    sourceVersionId: string;
    sourceBounds: { x: number; y: number; width: number; height: number };
    matteHash: string | null;
    width: number;
    height: number;
    alphaStatus: "transparent";
    sha256: string;
    provider: string | null;
    model: string | null;
  }>;
  coverage: Array<{
    requirementId: string;
    elementIds: string[];
    status: "present" | "missing" | "uncertain";
    note: string;
  }>;
};

/** File-safe stem for an element name: lowercase ASCII words joined by hyphens. */
function safeElementName(name: string): string {
  const collapsed = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Truncation can expose a new trailing hyphen, so trim again afterwards.
  const truncated = collapsed.slice(0, SAFE_NAME_MAX).replace(/-+$/g, "");
  return truncated.length > 0 ? truncated : SAFE_NAME_FALLBACK;
}

/**
 * Archive entry for one exported PNG. The archive is flat, so the name is only a
 * label: the element UUID keeps entries unique and the name can never contribute
 * a directory or a traversal segment.
 */
export function packEntryPath(name: string, elementId: string): string {
  if (!UUID_PATTERN.test(elementId)) {
    throw new GameUiError("INVALID_REQUEST", "Pack entries need an element UUID");
  }
  return `${ASSET_ENTRY_PREFIX}${safeElementName(name)}-${elementId}.png`;
}

/**
 * Manifest for one pinned export. `screen.spec` is the render's frozen spec
 * snapshot, so the file stays a description of what was exported even after the
 * draft or the style has moved on.
 */
export function buildPackManifest(input: PackManifestInput): Record<string, unknown> {
  return {
    manifest_version: MANIFEST_VERSION,
    style: { id: input.style.id, revision: input.style.revision },
    screen: {
      id: input.screen.id,
      render_id: input.screen.renderId,
      source_version_id: input.screen.sourceVersionId,
      width: input.screen.width,
      height: input.screen.height,
      spec_snapshot: input.screen.spec,
    },
    element_set: { id: input.elementSet.id, revision: input.elementSet.revision },
    // Every defined element is listed so parent references resolve even when the
    // parent itself was not selected for export.
    elements: input.elements.map((element) => ({
      id: element.id,
      parent_id: element.parentId,
      kind: element.kind,
      custom_type: element.customType,
      name: element.name,
      purpose: element.purpose,
      visible_text: element.visibleText,
      visible_state: element.visibleState,
      bounds: {
        x: element.bounds.x,
        y: element.bounds.y,
        width: element.bounds.width,
        height: element.bounds.height,
      },
      z_index: element.zIndex,
      occluded: element.occluded,
    })),
    assets: input.assets.map((asset) => ({
      element_id: asset.elementId,
      output_id: asset.outputId,
      asset_id: asset.assetId,
      version_id: asset.versionId,
      path: asset.path,
      mode: asset.mode,
      source_version_id: asset.sourceVersionId,
      source_bounds: {
        x: asset.sourceBounds.x,
        y: asset.sourceBounds.y,
        width: asset.sourceBounds.width,
        height: asset.sourceBounds.height,
      },
      matte_hash: asset.matteHash,
      width: asset.width,
      height: asset.height,
      alpha_status: asset.alphaStatus,
      sha256: asset.sha256,
      provider: asset.provider,
      model: asset.model,
    })),
    coverage: input.coverage.map((entry) => ({
      requirement_id: entry.requirementId,
      element_ids: [...entry.elementIds],
      status: entry.status,
      note: entry.note,
    })),
  };
}

/**
 * Guards the client's selection against the server's pinned set before anything
 * is downloaded. Ids that do not belong to this render are the caller's 404
 * concern: resolving them needs the database, so a caller that must answer 404
 * looks the selection up first. Here an unknown id fails closed instead.
 */
export function assertPackSelection(params: {
  elementSetId: string;
  latestSetId: string;
  outputs: Array<{
    outputId: string;
    elementSetId: string;
    elementId: string;
    mode: string;
    alphaStatus: string;
    reviewStatus: string;
    renderId: string;
  }>;
  selectedOutputIds: string[];
  renderId: string;
  groupElementIds: string[];
}): void {
  const { elementSetId, latestSetId, outputs, selectedOutputIds, renderId, groupElementIds } = params;

  if (elementSetId !== latestSetId) {
    throw new GameUiError(
      "ASSET_PACK_NOT_READY",
      "This element set is no longer the current revision: rebuild the pack from the latest set",
    );
  }
  if (selectedOutputIds.length === 0) {
    throw new GameUiError("ASSET_PACK_NOT_READY", "Select at least one exported element to build a pack");
  }

  const byOutputId = new Map(outputs.map((output) => [output.outputId, output]));
  const groupIds = new Set(groupElementIds);
  const selectedElementIds = new Set<string>();

  for (const outputId of selectedOutputIds) {
    const output = byOutputId.get(outputId);
    if (!output) {
      throw new GameUiError("ASSET_PACK_NOT_READY", `Output ${outputId} is not part of this render`);
    }
    if (output.renderId !== renderId) {
      throw new GameUiError("ASSET_PACK_NOT_READY", `Output ${outputId} belongs to another render`);
    }
    if (output.elementSetId !== elementSetId) {
      throw new GameUiError("ASSET_PACK_NOT_READY", `Output ${outputId} belongs to another element set revision`);
    }
    if (output.reviewStatus !== "accepted") {
      throw new GameUiError("ASSET_PACK_NOT_READY", `Output ${outputId} has not been accepted yet`);
    }
    if (output.alphaStatus !== "transparent") {
      throw new GameUiError("ASSET_PACK_NOT_READY", `Output ${outputId} has no transparency to export`);
    }
    if (groupIds.has(output.elementId)) {
      throw new GameUiError("ASSET_PACK_NOT_READY", "A group only organizes the screen and has no pixels to export");
    }
    if (selectedElementIds.has(output.elementId)) {
      throw new GameUiError("ASSET_PACK_NOT_READY", "Two selected outputs export the same element");
    }
    selectedElementIds.add(output.elementId);
  }
}
