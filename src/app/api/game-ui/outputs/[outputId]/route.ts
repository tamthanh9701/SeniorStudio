// Accept or discard one element output.  The decision is a CAS on the status the
// caller observed, so two tabs cannot silently overwrite each other's review,
// and an opaque output can never be accepted as a transparent pack asset.
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson } from "@/lib/game-ui/http";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const ReviewSchema = z
  .object({
    expectedReviewStatus: z.enum(["pending", "accepted", "discarded"]),
    status: z.enum(["accepted", "discarded"]),
  })
  .strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ outputId: string }> }) {
  const { outputId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = ReviewSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }

  try {
    // The RPC proves workspace membership itself, so a foreign output id answers
    // 404 without this route ever reading the row.
    const { data, error } = await supabase
      .rpc("review_game_ui_output", {
        p_output_id: outputId,
        p_expected_status: parsed.data.expectedReviewStatus,
        p_status: parsed.data.status,
      })
      .single();
    if (error) throw error;
    return NextResponse.json({ output: data });
  } catch (error) {
    return errorResponse(error);
  }
}
