import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

// Selective update: the caller states the current version it observed so two
// reviewers cannot silently overwrite each other's decision.
const SelectVersionSchema = z
  .object({ versionId: z.string().uuid(), expectedCurrentVersionId: z.string().uuid().nullable() })
  .strict();

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  }
  if (!z.string().uuid().safeParse(assetId).success) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Asset not found" } }, { status: 404 });
  }

  const parsed = SelectVersionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "versionId and expectedCurrentVersionId are required" } }, { status: 400 });
  }

  const { data, error } = await supabase
    .rpc("select_asset_version", {
      p_asset_id: assetId,
      p_version_id: parsed.data.versionId,
      p_expected_current_version_id: parsed.data.expectedCurrentVersionId,
    })
    .single();

  if (error) {
    const message = error.message;
    if (message.includes("VERSION_CONFLICT")) {
      return NextResponse.json({ error: { code: "VERSION_CONFLICT", message: "Another version was selected first; reload to see the current one" } }, { status: 409 });
    }
    if (message.includes("NOT_FOUND")) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Version not found" } }, { status: 404 });
    }
    return NextResponse.json({ error: { code: "UPDATE_FAILED", message } }, { status: 500 });
  }

  return NextResponse.json({ success: true, asset: data });
}
