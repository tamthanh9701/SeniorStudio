// Exact extraction: crop one element out of the render's immutable image with
// the matte the user painted.  The result is a separate style-owned asset, so
// the screen it came from can never be modified by an export.
import { NextResponse } from "next/server";
import { z } from "zod";

import { downloadOwnedBytes, getOwnedAssetVersion } from "@/lib/assets/ownership";
import { parseElementDocument } from "@/lib/game-ui/contracts";
import { GameUiError } from "@/lib/game-ui/errors";
import { errorResponse, readJson, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { extractElement } from "@/lib/game-ui/extraction";
import { MAX_INPUT_BYTES, sha256Hex, writeGameUiObject } from "@/lib/game-ui/upload";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const maxDuration = 60;

const ExtractSchema = z
  .object({
    elementSetId: z.string().uuid(),
    matteInputId: z.string().uuid(),
    outputId: z.string().uuid(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ renderId: string; elementId: string }> }) {
  const { renderId, elementId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = ExtractSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }

  try {
    const render = await requireOwnedRender(supabase, renderId);
    await requireGameUiStyle(supabase, render.style_id);
    const data = parsed.data;
    const service = getServiceClient();

    // The caller supplies the output id, which makes a retry idempotent: an
    // ambiguous first attempt answers with the row it created instead of
    // producing a second asset for the same crop.
    const { data: existing, error: existingError } = await supabase
      .from("game_ui_element_outputs")
      .select("*")
      .eq("id", data.outputId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      const row = existing as Record<string, unknown>;
      if (
        row.render_id !== renderId ||
        row.element_set_id !== data.elementSetId ||
        row.element_id !== elementId ||
        row.matte_input_id !== data.matteInputId
      ) {
        throw new GameUiError("CONFLICT", "That output id already belongs to a different extraction");
      }
      return NextResponse.json({ output: row }, { status: 201 });
    }

    const source = await getOwnedAssetVersion(service, render.workspace_id, render.asset_id, render.version_id);

    const { data: setRow, error: setError } = await supabase
      .from("game_ui_element_sets")
      .select("id, revision, document")
      .eq("id", data.elementSetId)
      .eq("render_id", renderId)
      .maybeSingle();
    if (setError || !setRow) throw new GameUiError("ELEMENT_NOT_FOUND", "Element map revision not found");

    const document = parseElementDocument((setRow as { document: unknown }).document, {
      width: source.version.width,
      height: source.version.height,
    });
    const element = document.elements.find((entry) => entry.id === elementId);
    if (!element) throw new GameUiError("ELEMENT_NOT_FOUND", "Element not found in this element map revision");
    if (element.kind === "group") {
      throw new GameUiError("INVALID_REQUEST", "A group only organizes the screen and has no pixels to extract");
    }

    // The matte must be the one painted for this exact element of this exact
    // revision; anything else would composite alpha over the wrong pixels.
    const { data: matte, error: matteError } = await supabase
      .from("game_ui_inputs")
      .select("id, version_id, width, height")
      .eq("id", data.matteInputId)
      .eq("kind", "element_matte")
      .eq("render_id", renderId)
      .eq("element_set_id", data.elementSetId)
      .eq("element_id", elementId)
      .eq("style_id", render.style_id)
      .maybeSingle();
    if (matteError || !matte) throw new GameUiError("INPUT_NOT_FOUND", "Foreground matte not found for this element");

    const { data: matteVersion, error: matteVersionError } = await service
      .from("asset_versions")
      .select("asset_id")
      .eq("id", matte.version_id)
      .maybeSingle();
    if (matteVersionError || !matteVersion) throw new GameUiError("INPUT_NOT_FOUND", "Foreground matte bytes are missing");
    const matteOwned = await getOwnedAssetVersion(service, render.workspace_id, (matteVersion as { asset_id: string }).asset_id, matte.version_id);
    const matteBytes = await downloadOwnedBytes(service, matteOwned.owned);

    const sourceBytes = await downloadOwnedBytes(service, source.owned);
    const result = await extractElement({ sourceBytes: sourceBytes.bytes, matteBytes: matteBytes.bytes, bounds: element.bounds });
    if (result.transparentPixels === 0) {
      throw new GameUiError("BACKGROUND_NOT_REMOVED", "Every pixel is still opaque: paint the background out before extracting");
    }
    if (result.visiblePixels === 0) {
      throw new GameUiError("INVALID_REQUEST", "The extraction has no visible pixels; check the matte and the element box");
    }
    // The output commit enforces the same ceiling; checking here keeps a huge
    // crop from being uploaded only to be refused.
    if (result.png.byteLength > MAX_INPUT_BYTES) {
      throw new GameUiError("REFERENCE_TOO_LARGE", "The extracted PNG is larger than 5 MB; select a smaller element");
    }

    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const storagePath = `${render.workspace_id}/styles/${render.style_id}/outputs/${assetId}/${versionId}/source.png`;
    const contentHash = sha256Hex(result.png);

    const output = await writeGameUiObject({
      service,
      workspaceId: render.workspace_id,
      styleId: render.style_id,
      operation: "element_output",
      assetId,
      versionId,
      storagePath,
      inputId: null,
      outputId: data.outputId,
      bytes: result.png,
      mimeType: "image/png",
      commit: async () => {
        const { data: committed, error } = await service
          .rpc("commit_game_ui_extraction", {
            p_output_id: data.outputId,
            p_render_id: renderId,
            p_element_set_id: data.elementSetId,
            p_element_id: elementId,
            p_matte_input_id: data.matteInputId,
            p_asset_id: assetId,
            p_version_id: versionId,
            p_file: {
              storage_path: storagePath,
              mime_type: "image/png",
              content_hash: contentHash,
              name: element.name,
              byte_size: result.png.byteLength,
              width: result.width,
              height: result.height,
              alpha_status: result.alphaStatus,
            },
          })
          .single();
        if (error) throw error;
        return (committed as Record<string, unknown> | null) ?? null;
      },
      readCommitted: async () => {
        const { data: row } = await service.from("game_ui_element_outputs").select("*").eq("id", data.outputId).maybeSingle();
        return (row as Record<string, unknown> | null) ?? null;
      },
    });

    return NextResponse.json({ output }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
