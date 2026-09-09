import { NextResponse } from "next/server";
import { z } from "zod";
import { STORAGE_BUCKET } from "@/db/schema";
import { createClient } from "@/supabase/server";
import { enforceAiQuota } from "@/lib/ai/quota";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { runStyleVisionAction } from "@/lib/style/vision-actions";
import { evaluateStyleFidelity } from "@/lib/style/fidelity-evaluator";
import type { StyleFingerprint } from "@/lib/style/fingerprint";

export const maxDuration = 180;

const TuneSchema = z.object({
  generatedImageUrls: z.array(z.string().url()).min(1).max(4),
  targetImageUrls: z.array(z.string().url()).max(4).optional(),
  feedback: z.string().trim().max(3000).optional(),
}).strict();

const REFINE_PROMPT_SYSTEM = `You are a style prompt refinement expert. Compare [GENERATED] images against optional [FEEDBACK] target images and [REFERENCE] ground-truth images. Identify style drift, not subject differences. Return ONLY strict JSON: {"drift_summary":"string","confidence":"high|medium|low","suggested_changes":[{"group":"string","field":"string","current_value":unknown,"suggested_value":unknown,"reason":"string"}]}.`;

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const quota = await enforceAiQuota(request, "brain");
  if (!quota.ok) return quota.response;
  const { styleId } = await params;
  const supabase = await createClient();
  const parsed = TuneSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("schema, fingerprint, workspace_id").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });
  const { data: references } = await supabase.from("style_references").select("storage_path").eq("style_id", styleId).order("created_at");
  const referenceUrls = await Promise.all((references ?? []).slice(0, 4).map(async (reference) => {
    const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(reference.storage_path, 300);
    return data?.signedUrl ?? null;
  }));

  try {
    const targetUrls = parsed.data.targetImageUrls ?? [];
    const validReferenceUrls = referenceUrls.filter((url): url is string => Boolean(url));
    const message = [
      `The first ${parsed.data.generatedImageUrls.length} images are [GENERATED].`,
      targetUrls.length ? `The next ${targetUrls.length} images are [FEEDBACK].` : "No [FEEDBACK] images were supplied.",
      `The final ${validReferenceUrls.length} images are [REFERENCE].`,
      `Current prompt context: ${JSON.stringify(style.schema ?? {})}`,
      parsed.data.feedback ? `User feedback: ${parsed.data.feedback}` : "",
    ].filter(Boolean).join("\n");
    const suggestion = await runStyleVisionAction({
      client: supabase,
      workspaceId: style.workspace_id,
      systemPrompt: REFINE_PROMPT_SYSTEM,
      userMessage: message,
      imageUrls: [...parsed.data.generatedImageUrls, ...targetUrls, ...validReferenceUrls],
    });
    const fidelity = evaluateStyleFidelity({
      fingerprint: style.fingerprint as StyleFingerprint | null,
      contentPrompt: parsed.data.feedback,
    });
    const lastFidelity = { evaluation: fidelity, suggestion, evaluatedAt: new Date().toISOString() };
    await supabase.from("styles").update({ last_fidelity: lastFidelity }).eq("id", styleId);
    return NextResponse.json({ suggestion, fidelity });
  } catch (error) {
    return NextResponse.json({ error: { code: "STYLE_ANALYSIS_FAILED", message: error instanceof Error ? error.message : "Tuning failed" } }, { status: 502 });
  }
}
