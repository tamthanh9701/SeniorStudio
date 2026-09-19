// Ask the configured vision model for a first-draft requirement list.  The
// answer is a proposal: this route never writes, the editor saves it through
// save_game_ui_screen like any other edit.
import { NextResponse } from "next/server";
import { z } from "zod";

import { enforceAiQuota } from "@/lib/ai/quota";
import { errorResponse, readJson, requireGameUiStyle, requireOwnedScreen } from "@/lib/game-ui/http";
import { suggestGameUiScreenSpec } from "@/lib/game-ui/screen-analysis";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

/** A vision call with one bounded image; the provider timeout is 150s. */
export const maxDuration = 180;

const SuggestSchema = z.object({ expectedRevision: z.number().int().min(1) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ screenId: string }> }) {
  const { screenId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = SuggestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }
  try {
    // Ownership before quota: a foreign or visual id must not spend a paid call.
    const screen = await requireOwnedScreen(supabase, screenId);
    await requireGameUiStyle(supabase, screen.style_id);
    const quota = await enforceAiQuota(request, "brain");
    if (!quota.ok) return quota.response;
    const result = await suggestGameUiScreenSpec(supabase, getServiceClient(), {
      screenId,
      expectedRevision: parsed.data.expectedRevision,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
