// One generated screen: its immutable source image, the specification snapshot
// it was generated from, the newest element map and the extracted element
// outputs.  Everything the render page paints on first load comes from here.
import { NextResponse } from "next/server";
import { z } from "zod";

import { GameUiError } from "@/lib/game-ui/errors";
import { errorResponse, requireGameUiStyle, requireOwnedRender } from "@/lib/game-ui/http";
import { getGameUiRenderDetail } from "@/lib/game-ui/service";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const OutputsQuerySchema = z.object({
  outputsCursor: z.string().min(1).max(512).optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ renderId: string }> }) {
  const { renderId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const query = OutputsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "outputsCursor must be the value returned by the previous page" } },
      { status: 400 },
    );
  }
  try {
    const render = await requireOwnedRender(supabase, renderId);
    await requireGameUiStyle(supabase, render.style_id);
    const detail = await getGameUiRenderDetail(supabase, renderId, query.data.outputsCursor ?? null);
    if (!detail) throw new GameUiError("RENDER_NOT_FOUND", "Generated screen not found");
    return NextResponse.json({
      render: detail.render,
      spec: detail.spec,
      elementSet: detail.elementSet,
      outputs: detail.outputs,
      outputsNextCursor: detail.outputsNextCursor,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
