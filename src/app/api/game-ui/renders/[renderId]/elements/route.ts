// Save a reviewed element map for one generated screen.  Revisions are
// append-only: the RPC compares the caller's expected revision with the newest
// saved set, so two editors cannot silently overwrite each other's map.
import { NextResponse } from "next/server";
import { z } from "zod";

import { parseElementDocument } from "@/lib/game-ui/contracts";
import { GameUiError } from "@/lib/game-ui/errors";
import { errorResponse, readJson, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const SaveElementsSchema = z
  .object({
    // 0 means "this render has no saved map yet"; the RPC refuses anything else
    // when a set already exists.
    expectedRevision: z.number().int().min(0),
    document: z.unknown(),
  })
  .strict();

export async function PUT(request: Request, { params }: { params: Promise<{ renderId: string }> }) {
  const { renderId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = SaveElementsSchema.safeParse(await readJson(request));
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
    // The version row carries the decoded size the map is drawn against; a map
    // for another size would crop the wrong pixels at export time.
    const { data: version } = await supabase
      .from("asset_versions")
      .select("id, width, height")
      .eq("id", render.version_id)
      .eq("asset_id", render.asset_id)
      .maybeSingle();
    if (!version || typeof version.width !== "number" || typeof version.height !== "number") {
      throw new GameUiError("RENDER_NOT_FOUND", "The generated screen version no longer exists");
    }
    const document = parseElementDocument(parsed.data.document, { width: version.width, height: version.height });
    // The database validator enforces the same provenance; naming the mismatch
    // here keeps a mixed-up document from reaching the RPC at all.
    if (document.render_id !== renderId || document.source_version_id !== render.version_id) {
      throw new GameUiError("INVALID_REQUEST", "The element document belongs to another generated screen");
    }
    const { data: elementSet, error } = await supabase
      .rpc("save_game_ui_elements", {
        p_render_id: renderId,
        p_expected_revision: parsed.data.expectedRevision,
        p_document: document,
      })
      .single();
    if (error) throw error;
    return NextResponse.json({ elementSet });
  } catch (error) {
    return errorResponse(error);
  }
}
