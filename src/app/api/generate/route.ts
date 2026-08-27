import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { requireOpenAIKey } from "@/env";

export async function POST(request: Request) {
  // Check if OpenAI direct generation is configured
  try {
    requireOpenAIKey();
  } catch {
    return NextResponse.json(
      { error: "Direct generation not configured. Use MCP handoff from ChatGPT." },
      { status: 503 }
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { assetId, parentVersionId, prompt, maskPng } = await request.json();

  if (!assetId || !parentVersionId || !prompt) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Get workspace ID
  const { data: member } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const { editImage } = await import("@/lib/openai/images");
    const result = await editImage({
      assetId,
      parentVersionId,
      workspaceId: member.workspace_id,
      prompt,
      maskPng,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Edit failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Edit failed" },
      { status: 500 }
    );
  }
}
