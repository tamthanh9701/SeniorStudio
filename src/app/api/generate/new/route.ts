import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { requireOpenAIKey } from "@/env";

export async function POST(request: Request) {
  // Check if OpenAI direct generation is configured
  try {
    requireOpenAIKey();
  } catch {
    return NextResponse.json(
      { error: "Direct Responses API generation is not configured. Generate in ChatGPT and save the result through SeniorStudio MCP." },
      { status: 503 }
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, prompt, size, quality, count } = await request.json();

  if (!projectId || !prompt) {
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
    const { generateImage } = await import("@/lib/openai/images");
    const results = [];
    
    // Generate images in parallel (up to 4)
    for (let i = 0; i < Math.min(count, 4); i++) {
      const result = await generateImage({
        projectId,
        workspaceId: member.workspace_id,
        prompt,
        size,
        quality,
      });
      
      results.push({
        status: "succeeded",
        assetId: result.results[0]?.asset.id,
      });
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Generation failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Generation failed" },
      { status: 500 }
    );
  }
}
