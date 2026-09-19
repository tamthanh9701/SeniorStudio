// Attach a wireframe raster to a Game UI style.  The bytes become a style-owned
// source asset classified as a wireframe input; the screen draft is not touched
// here, because a draft update has its own revision CAS and must not ride on an
// upload.
import { NextResponse } from "next/server";

import { errorResponse, requireGameUiStyle } from "@/lib/game-ui/http";
import { MAX_INPUT_BYTES, readImageUpload, uploadGameUiInput } from "@/lib/game-ui/upload";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const maxDuration = 60;

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  try {
    const style = await requireGameUiStyle(supabase, styleId);
    const file = await readImageUpload(request, { maxBytes: MAX_INPUT_BYTES, allowedMime: ALLOWED_MIME });
    const uploaded = await uploadGameUiInput({
      service: getServiceClient(),
      workspaceId: style.workspace_id,
      styleId,
      kind: "wireframe",
      file,
      context: null,
    });
    return NextResponse.json(
      { inputId: uploaded.inputId, assetId: uploaded.assetId, versionId: uploaded.versionId, width: uploaded.width, height: uploaded.height, signedUrl: uploaded.signedUrl },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
