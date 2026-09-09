import { NextResponse } from "next/server";
import { z } from "zod";
import { STORAGE_BUCKET } from "@/db/schema";
import { createClient } from "@/supabase/server";
import { enforceAiQuota } from "@/lib/ai/quota";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { runStyleVisionAction } from "@/lib/style/vision-actions";

export const maxDuration = 180;

const EvaluateSchema = z.object({
  generatedImageUrls: z.array(z.string().url()).min(1).max(4),
  feedback: z.string().trim().max(3000).optional(),
}).strict();

const EVALUATE_FIDELITY_SYSTEM = `You are a senior visual QA director. Judge generated images against reference images and the style profile. Evaluate style separately from subject. Return ONLY strict JSON: {"style_fidelity_score":0,"content_match_score":0,"verdict":"ready|needs_tuning|not_ready","summary":"string","strengths":["string"],"drift":[{"aspect":"lighting|color|material|composition|linework|mood|other","severity":"minor|moderate|major","detail":"string"}],"recommendation":"string"}. Scores must be 0-100.`;

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const quota = await enforceAiQuota(request, "brain");
  if (!quota.ok) return quota.response;
  const { styleId } = await params;
  const supabase = await createClient();
  const parsed = EvaluateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("schema, workspace_id").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });
  const { data: references } = await supabase.from("style_references").select("storage_path").eq("style_id", styleId).order("created_at");
  const referenceUrls = await Promise.all((references ?? []).slice(0, 4).map(async (reference) => {
    const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(reference.storage_path, 300);
    return data?.signedUrl ?? null;
  }));
  const validReferenceUrls = referenceUrls.filter((url): url is string => Boolean(url));

  try {
    const report = await runStyleVisionAction({
      client: supabase,
      workspaceId: style.workspace_id,
      systemPrompt: EVALUATE_FIDELITY_SYSTEM,
      userMessage: [
        `The first ${parsed.data.generatedImageUrls.length} images are [GENERATED].`,
        `The next ${validReferenceUrls.length} images are [REFERENCE].`,
        `Style profile JSON: ${JSON.stringify(style.schema ?? {})}`,
        parsed.data.feedback ? `Reviewer note: ${parsed.data.feedback}` : "",
      ].filter(Boolean).join("\n"),
      imageUrls: [...parsed.data.generatedImageUrls, ...validReferenceUrls],
    });
    await supabase.from("styles").update({ last_fidelity: { report, evaluatedAt: new Date().toISOString() } }).eq("id", styleId);
    return NextResponse.json({ report });
  } catch (error) {
    return NextResponse.json({ error: { code: "STYLE_ANALYSIS_FAILED", message: error instanceof Error ? error.message : "Evaluation failed" } }, { status: 502 });
  }
}
