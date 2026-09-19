// Screen drafts of one Game UI style.  Creation and every later edit go through
// save_game_ui_screen, so the draft revision CAS lives in the database: a screen
// saved from a stale editor is refused there even if two routes race.
import { NextResponse } from "next/server";
import { z } from "zod";

import { parseScreenSpec } from "@/lib/game-ui/contracts";
import { errorResponse, readJson, requireGameUiStyle } from "@/lib/game-ui/http";
import { listGameUiScreens } from "@/lib/game-ui/service";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const CreateScreenSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    // The spec itself goes through parseScreenSpec, which also rejects a repeated
    // requirement id and the custom/kind mismatch a bare shape check cannot see.
    spec: z.unknown(),
    wireframeVersionId: z.string().uuid().nullable().optional(),
  })
  .strict();

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(512).optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const query = ListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "limit must be 1-50 and cursor must be the value returned by the previous page" } },
      { status: 400 },
    );
  }
  try {
    await requireGameUiStyle(supabase, styleId);
    const page = await listGameUiScreens(supabase, styleId, { limit: query.data.limit, cursor: query.data.cursor ?? null });
    return NextResponse.json({ screens: page.screens, nextCursor: page.nextCursor });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = CreateScreenSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }
  try {
    await requireGameUiStyle(supabase, styleId);
    const spec = parseScreenSpec(parsed.data.spec);
    // The id is allocated here so a retried request after a network failure cannot
    // create a second screen with the same draft.
    const screenId = crypto.randomUUID();
    const { data: screen, error } = await supabase
      .rpc("save_game_ui_screen", {
        p_style_id: styleId,
        p_screen_id: screenId,
        p_expected_revision: 0,
        p_name: parsed.data.name,
        p_spec: spec,
        p_wireframe_version_id: parsed.data.wireframeVersionId ?? null,
      })
      .single();
    if (error) throw error;
    return NextResponse.json({ screen }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
