// Foreground matte for one element of the newest element map.  The matte is a
// canvas of alpha values sized exactly like the element's box, so it is stored
// as its own classified input and never as part of the element map: the map
// stays a description, the matte is the pixels the user actually painted.
import { NextResponse } from "next/server";

import { parseElementDocument } from "@/lib/game-ui/contracts";
import { GameUiError } from "@/lib/game-ui/errors";
import { errorResponse, latestElementSet, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { MAX_INPUT_BYTES, readImageUpload, uploadGameUiInput } from "@/lib/game-ui/upload";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const maxDuration = 60;

/** Alpha 255 keeps a pixel and 0 removes it; anything else cannot mask a crop. */
const ALLOWED_MIME = ["image/png"] as const;

export async function POST(request: Request, { params }: { params: Promise<{ renderId: string; elementId: string }> }) {
  const { renderId, elementId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  try {
    const render = await requireOwnedRender(supabase, renderId);
    await requireGameUiStyle(supabase, render.style_id);

    const file = await readImageUpload(request, { maxBytes: MAX_INPUT_BYTES, allowedMime: ALLOWED_MIME });
    if (!file.hasAlpha) {
      throw new GameUiError("UNSUPPORTED_IMAGE_TYPE", "A matte must be an RGBA PNG with an alpha channel");
    }
    const elementSetId = file.form.get("elementSetId");
    if (typeof elementSetId !== "string" || elementSetId.length === 0) {
      throw new GameUiError("INVALID_REQUEST", "elementSetId is required for a matte");
    }

    const { data: setRow, error: setError } = await supabase
      .from("game_ui_element_sets")
      .select("id, revision, document")
      .eq("id", elementSetId)
      .eq("render_id", renderId)
      .maybeSingle();
    if (setError || !setRow) throw new GameUiError("ELEMENT_NOT_FOUND", "Element map revision not found");

    const latest = await latestElementSet(supabase, renderId);
    if (!latest || latest.id !== elementSetId) {
      throw new GameUiError("SCREEN_VERSION_CONFLICT", "This element map has a newer revision; reload before painting a matte");
    }

    const document = parseElementDocument((setRow as { document: unknown }).document);
    const element = document.elements.find((entry) => entry.id === elementId);
    if (!element) {
      throw new GameUiError("SCREEN_VERSION_CONFLICT", "The element is not part of the newest element map revision");
    }
    if (element.kind === "group") {
      throw new GameUiError("INVALID_REQUEST", "A group only organizes the screen and has no pixels to mask");
    }
    if (file.width !== element.bounds.width || file.height !== element.bounds.height) {
      throw new GameUiError(
        "INVALID_REQUEST",
        `Matte is ${file.width}x${file.height} but the element box is ${element.bounds.width}x${element.bounds.height}`,
      );
    }

    const uploaded = await uploadGameUiInput({
      service: getServiceClient(),
      workspaceId: render.workspace_id,
      styleId: render.style_id,
      kind: "element_matte",
      file,
      context: { render_id: renderId, element_set_id: elementSetId, element_id: elementId },
    });
    return NextResponse.json({ inputId: uploaded.inputId }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
