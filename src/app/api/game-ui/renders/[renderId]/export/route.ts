// Pin one pack: the server decides which versions may leave the workspace, then
// hands the browser hashes, archive entry names and short-lived URLs.  The
// manifest deliberately carries no storage path or signed URL, because the ZIP
// is meant to stay readable after the links have expired.
import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwnedAssetVersion, signOwnedUrl } from "@/lib/assets/ownership";
import { parseElementDocument, type ElementDocument } from "@/lib/game-ui/contracts";
import { GameUiError } from "@/lib/game-ui/errors";
import { errorResponse, latestElementSet, readJson, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { assertPackSelection, buildPackManifest, packEntryPath, type PackManifestInput } from "@/lib/game-ui/manifest";
import { ORGANIZATIONAL_KINDS } from "@/lib/game-ui/taxonomy";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const maxDuration = 60;

/** Short-lived on purpose: the browser refreshes the same pinned ids on expiry. */
const URL_TTL_SECONDS = 600;

const ExportSchema = z
  .object({
    elementSetId: z.string().uuid(),
    outputIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, { message: "outputIds must be unique" }),
  })
  .strict();

type RenderAuthority = {
  id: string;
  workspace_id: string;
  style_id: string;
  screen_id: string;
  asset_id: string;
  version_id: string;
  spec_snapshot: unknown;
  style_revision: string;
};

/** Only the columns the pack needs; the guard reads the rest from the same rows. */
type SelectedOutput = {
  id: string;
  render_id: string;
  element_set_id: string;
  element_id: string;
  mode: "exact" | "reconstructed";
  alpha_status: string;
  review_status: string;
  asset_id: string;
  version_id: string;
  source_bounds: { x: number; y: number; width: number; height: number };
  provider: string | null;
  model: string | null;
};

export async function POST(request: Request, { params }: { params: Promise<{ renderId: string }> }) {
  const { renderId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = ExportSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }

  try {
    const render = (await requireOwnedRender(supabase, renderId)) as RenderAuthority;
    await requireGameUiStyle(supabase, render.style_id);
    const { elementSetId, outputIds } = parsed.data;
    const service = getServiceClient();

    const source = await getOwnedAssetVersion(service, render.workspace_id, render.asset_id, render.version_id);
    const latest = await latestElementSet(supabase, renderId);

    // Only the newest revision may be exported, so its document is the one that
    // names the elements; a stale set id fails the selection guard below.
    let document: ElementDocument | null = null;
    const groupElementIds: string[] = [];
    if (latest && latest.id === elementSetId) {
      document = parseElementDocument(latest.document, { width: source.version.width, height: source.version.height });
      groupElementIds.push(
        ...document.elements.filter((element) => ORGANIZATIONAL_KINDS.includes(element.kind)).map((element) => element.id),
      );
    }

    const { data: rows, error } = await supabase
      .from("game_ui_element_outputs")
      .select("id, render_id, element_set_id, element_id, mode, alpha_status, review_status, asset_id, version_id, source_bounds, provider, model")
      .in("id", outputIds);
    if (error) throw error;

    const selectedRows = (rows ?? []) as SelectedOutput[];
    assertPackSelection({
      elementSetId,
      latestSetId: latest?.id ?? "",
      outputs: selectedRows.map((row) => ({
        outputId: row.id,
        elementSetId: row.element_set_id,
        elementId: row.element_id,
        mode: row.mode,
        alphaStatus: row.alpha_status,
        reviewStatus: row.review_status,
        renderId: row.render_id,
      })),
      selectedOutputIds: outputIds,
      renderId,
      groupElementIds,
    });

    // The guard above proved the set is the newest one, so the document exists.
    if (!document || !latest) throw new GameUiError("ASSET_PACK_NOT_READY", "This render has no exported element map");

    const files: Array<{ outputId: string; path: string; url: string; byteSize: number; sha256: string }> = [];
    const assets: PackManifestInput["assets"] = [];
    for (const outputId of outputIds) {
      const row = selectedRows.find((candidate) => candidate.id === outputId);
      if (!row) throw new GameUiError("ASSET_PACK_NOT_READY", `Output ${outputId} is not part of this render`);
      const element = document.elements.find((candidate) => candidate.id === row.element_id);
      if (!element) {
        throw new GameUiError("ASSET_PACK_NOT_READY", `Output ${outputId} names an element outside this map revision`);
      }
      const owned = await getOwnedAssetVersion(service, render.workspace_id, row.asset_id, row.version_id);
      const sha256 = owned.version.metadata.content_hash;
      if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new GameUiError("INVALID_REQUEST", `Output ${outputId} has no recorded content hash`);
      }
      const path = packEntryPath(element.name, element.id);
      files.push({
        outputId,
        path,
        url: await signOwnedUrl(service, owned.owned, URL_TTL_SECONDS),
        byteSize: owned.version.byte_size,
        sha256,
      });
      assets.push({
        elementId: element.id,
        outputId,
        assetId: row.asset_id,
        versionId: row.version_id,
        path,
        mode: row.mode,
        sourceVersionId: render.version_id,
        sourceBounds: row.source_bounds,
        matteHash: typeof owned.version.metadata.matte_hash === "string" ? owned.version.metadata.matte_hash : null,
        width: owned.version.width,
        height: owned.version.height,
        // Only transparent outputs reach this point; the guard rejects the rest.
        alphaStatus: "transparent",
        sha256,
        provider: row.provider,
        model: row.model,
      });
    }
    // A short pack would silently ship a subset of what the user selected.
    if (files.length !== outputIds.length) {
      throw new GameUiError("INVALID_REQUEST", "The pack did not resolve every selected output");
    }

    const manifest = buildPackManifest({
      style: { id: render.style_id, revision: render.style_revision },
      screen: {
        id: render.screen_id,
        renderId,
        sourceVersionId: render.version_id,
        width: source.version.width,
        height: source.version.height,
        spec: render.spec_snapshot,
      },
      elementSet: { id: elementSetId, revision: latest.revision },
      elements: document.elements.map((element) => ({
        id: element.id,
        parentId: element.parent_id,
        kind: element.kind,
        customType: element.custom_type,
        name: element.name,
        purpose: element.purpose,
        visibleText: element.visible_text,
        visibleState: element.visible_state,
        bounds: element.bounds,
        zIndex: element.z_index,
        occluded: element.occluded,
      })),
      assets,
      coverage: document.coverage.map((entry) => ({
        requirementId: entry.requirement_id,
        elementIds: entry.element_ids,
        status: entry.status,
        note: entry.note,
      })),
    });

    return NextResponse.json({
      manifest,
      files,
      expiresAt: new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
