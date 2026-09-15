import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { listStyleAssets } from "@/lib/style/style-assets";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ styleId: string }> }
) {
  const { styleId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { data: style, error: styleError } = await supabase
    .from("styles")
    .select("id, workspace_id")
    .eq("id", styleId)
    .single();

  if (styleError || !style) {
    return NextResponse.json(
      { error: { code: "STYLE_NOT_FOUND", message: "Style not found" } },
      { status: 404 }
    );
  }

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", style.workspace_id)
    .eq("supabase_user_id", user.id)
    .single();

  if (!membership) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Not a member of this workspace" } },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 24);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 24));
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam
    ? (() => {
        try {
          return JSON.parse(Buffer.from(cursorParam, "base64url").toString("utf-8")) as { createdAt: string; id: string };
        } catch {
          return null;
        }
      })()
    : null;

  let page: Awaited<ReturnType<typeof listStyleAssets>>;
  try {
    page = await listStyleAssets(supabase, styleId, { limit, cursor });
  } catch {
    return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load assets" } }, { status: 500 });
  }
  const { assets, nextCursor } = page;
  return NextResponse.json({ assets, pagination: { nextCursor } });
}
