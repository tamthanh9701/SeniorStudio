// Game UI style editing and confirmation.  The visual PATCH route refuses a Game
// UI style because its schema editor and linter describe a scene subject; this is
// the equivalent for this domain, and it keeps the same CAS and RPC boundaries.
//
// Editing and confirming are separate requests, exactly as in the visual module:
// confirming publishes the candidate, so doing both at once would publish a
// candidate the caller never saw.
import { NextResponse } from "next/server";
import { z } from "zod";

import { GameUiError } from "@/lib/game-ui/errors";
import { errorResponse, readJson, requireGameUiStyle } from "@/lib/game-ui/http";
import { getGameUiStyleDetail } from "@/lib/game-ui/service";
import { parseGameUiStyleSchema } from "@/lib/game-ui/style-schema";
import { commitStyleSchemaMutation, updateStyleFields } from "@/lib/style/schema-versions";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const EditGameUiStyleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    libraryId: z.string().uuid().nullable().optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    expectedUpdatedAt: z.string().min(1),
  })
  .strict();

const ConfirmGameUiStyleSchema = z
  .object({ status: z.literal("active"), expectedUpdatedAt: z.string().min(1) })
  .strict();

export async function GET(_request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  try {
    await requireGameUiStyle(supabase, styleId);
    const style = await getGameUiStyleDetail(supabase, styleId);
    if (!style) throw new GameUiError("NOT_FOUND", "Style not found");
    return NextResponse.json({ style });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const body = await readJson(request);
  const confirm = ConfirmGameUiStyleSchema.safeParse(body);
  const edit = EditGameUiStyleSchema.safeParse(body);
  try {
    await requireGameUiStyle(supabase, styleId);
    if (confirm.success && !edit.success) {
      const { error } = await supabase.rpc("confirm_style_definition", {
        p_style_id: styleId,
        p_expected_updated_at: confirm.data.expectedUpdatedAt,
      });
      if (error) throw error;
      // The detail shape, not the raw styles row: the workspace renders this
      // response in place of what it loaded, and a row of columns is not it.
      const confirmed = await getGameUiStyleDetail(supabase, styleId);
      return NextResponse.json({ style: confirmed });
    }
    if (!edit.success) {
      const issue = (confirm.success ? edit : edit).error.issues[0];
      throw new GameUiError("INVALID_REQUEST", `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
    }
    const data = edit.data;
    if (!data.schema && !data.name && data.libraryId === undefined) throw new GameUiError("INVALID_REQUEST", "Nothing to update");
    if (data.schema) {
      // The RPC validates the schema again for a Game UI style; parsing here gives
      // the field-level message the editor needs.
      const schema = parseGameUiStyleSchema(data.schema);
      await commitStyleSchemaMutation(supabase, {
        styleId,
        expectedUpdatedAt: data.expectedUpdatedAt,
        source: "manual",
        schema: schema as unknown as Record<string, unknown>,
        styleFields: data.name ? { name: data.name } : null,
        metadata: { edited: "game_ui_style" },
      });
    } else {
      await updateStyleFields(supabase, {
        styleId,
        expectedUpdatedAt: data.expectedUpdatedAt,
        name: data.name ?? undefined,
        libraryId: data.libraryId,
      });
    }
    const style = await getGameUiStyleDetail(supabase, styleId);
    return NextResponse.json({ style });
  } catch (error) {
    return errorResponse(error);
  }
}
