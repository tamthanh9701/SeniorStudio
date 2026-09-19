// Propose where the required elements are in one generated screen.  Detection is
// a draft: it returns a document the user reviews, and it never writes an element
// set, so a bad proposal cannot replace a reviewed map.
import { NextResponse } from "next/server";
import { z } from "zod";

import { enforceAiQuota } from "@/lib/ai/quota";
import { errorResponse, latestElementSet, readJson, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { detectGameUiElements } from "@/lib/game-ui/screen-analysis";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

/** A vision call over the rendered screen; the provider timeout is 150s. */
export const maxDuration = 180;

const DetectSchema = z.object({ expectedRevision: z.number().int().min(0) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ renderId: string }> }) {
  const { renderId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = DetectSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}` } },
      { status: 400 },
    );
  }
  try {
    // Ownership and staleness are proven before quota and before the paid call:
    // a map another editor already moved on must not be detected against.
    const render = await requireOwnedRender(supabase, renderId);
    await requireGameUiStyle(supabase, render.style_id);
    const savedRevision = (await latestElementSet(supabase, renderId))?.revision ?? 0;
    if (savedRevision !== parsed.data.expectedRevision) {
      return NextResponse.json(
        {
          error: { code: "SCREEN_VERSION_CONFLICT", message: "The element map changed since it was loaded; reload it" },
          // The page reloads or retries against this revision, matching the
          // expectedRevision the successful proposal carries.
          expectedRevision: savedRevision,
        },
        { status: 409 },
      );
    }
    const quota = await enforceAiQuota(request, "brain");
    if (!quota.ok) return quota.response;
    const result = await detectGameUiElements(supabase, getServiceClient(), { renderId });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
