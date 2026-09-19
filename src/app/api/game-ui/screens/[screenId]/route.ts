// One screen draft: its current specification plus the renders generated from it.
// PATCH is a draft edit only — the images already generated keep their own
// immutable spec snapshot, so editing here never rewrites history.
import { NextResponse } from "next/server";
import { z } from "zod";

import { parseScreenSpec } from "@/lib/game-ui/contracts";
import { GameUiError } from "@/lib/game-ui/errors";
import { errorResponse, readJson, requireGameUiStyle, requireOwnedScreen } from "@/lib/game-ui/http";
import { getGameUiScreen, listGameUiRenders } from "@/lib/game-ui/service";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const RendersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(512).optional(),
});

const PatchScreenSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    name: z.string().trim().min(1).max(100),
    spec: z.unknown(),
    // Required, and nullable: attaching and detaching a wireframe are both
    // explicit, so a client that omits the key cannot drop the current one.
    wireframeVersionId: z.string().uuid().nullable(),
  })
  .strict();

export async function GET(request: Request, { params }: { params: Promise<{ screenId: string }> }) {
  const { screenId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const query = RendersQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "limit must be 1-50 and cursor must be the value returned by the previous page" } },
      { status: 400 },
    );
  }
  try {
    const found = await getGameUiScreen(supabase, screenId);
    if (!found) throw new GameUiError("SCREEN_NOT_FOUND", "Screen not found");
    await requireGameUiStyle(supabase, found.styleId);
    const page = await listGameUiRenders(supabase, screenId, { limit: query.data.limit, cursor: query.data.cursor ?? null });
    return NextResponse.json({ screen: found.screen, renders: page.renders, nextCursor: page.nextCursor });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ screenId: string }> }) {
  const { screenId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = PatchScreenSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }
  try {
    const screen = await requireOwnedScreen(supabase, screenId);
    await requireGameUiStyle(supabase, screen.style_id);
    const spec = parseScreenSpec(parsed.data.spec);
    // The expected revision is the caller's, never the row's: the RPC is what
    // decides whether the draft moved while the editor was open.
    const { data: saved, error } = await supabase
      .rpc("save_game_ui_screen", {
        p_style_id: screen.style_id,
        p_screen_id: screenId,
        p_expected_revision: parsed.data.expectedRevision,
        p_name: parsed.data.name,
        p_spec: spec,
        p_wireframe_version_id: parsed.data.wireframeVersionId,
      })
      .single();
    if (error) throw error;
    return NextResponse.json({ screen: saved });
  } catch (error) {
    return errorResponse(error);
  }
}
