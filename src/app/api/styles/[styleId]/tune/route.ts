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
  generatedVersionIds: z.array(z.string().uuid()).min(1).max(4),
  uploadedSourceVersionIds: z.array(z.string().uuid()).min(0).max(4).optional(),
  feedback: z.string().trim().max(3000).optional(),
}).strict();

const REFINE_PROMPT_SYSTEM = `You are a style prompt refinement expert. Compare [GENERATED] images against optional [FEEDBACK] target images and [REFERENCE] ground-truth images. Identify style drift, not subject differences.

Return ONLY strict JSON:
{
  "drift_summary": "string",
  "confidence": "high|medium|low",
  "issues": [{ "id": "string", "category": "content|provider|schema", "evidence": "string", "reason": "string", "confidence": "high|medium|low" }],
  "changes": [{ "id": "string", "group": "string", "field": "string", "current_value": "string", "suggested_value": "string", "reason": "string", "issueIds": ["string"] }]
}

Only generate changes with category="schema". Do not generate changes for content or provider issues.
Each change must reference at least one issue by id.`;

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const quota = await enforceAiQuota(request, "brain");
  if (!quota.ok) return quota.response;
  const { styleId } = await params;
  const supabase = await createClient();
  const parsed = TuneSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("id, schema, fingerprint, workspace_id, updated_at").eq("id", styleId).single();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const versionIds = parsed.data.generatedVersionIds;
  const { data: versions, error: versionsError } = await supabase
    .from("asset_versions").select("id, asset_id, storage_path, prompt, metadata, assets!inner(style_id)").in("id", versionIds);
  if (versionsError || (versions?.length ?? 0) !== versionIds.length) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "One or more generated versions not found" } }, { status: 404 });
  }
  for (const version of versions ?? []) {
    if ((version.assets as { style_id?: string }).style_id !== styleId) {
      return NextResponse.json({ error: { code: "STYLE_CONFLICT", message: "Version does not belong to this style group" } }, { status: 409 });
    }
  }

  const uploadedIds = parsed.data.uploadedSourceVersionIds ?? [];
  const uploadedVersions: Array<{ storage_path: string; prompt: string | null }> = [];
  if (uploadedIds.length > 0) {
    const { data: sources, error: sourcesError } = await supabase
      .from("asset_versions").select("id, storage_path, prompt, assets!inner(style_id)").in("id", uploadedIds);
    if (sourcesError || (sources?.length ?? 0) !== uploadedIds.length) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "One or more uploaded source versions not found" } }, { status: 404 });
    }
    for (const source of sources ?? []) {
      if ((source.assets as { style_id?: string }).style_id !== styleId) {
        return NextResponse.json({ error: { code: "STYLE_CONFLICT", message: "Uploaded source does not belong to this style group" } }, { status: 409 });
      }
      if (!source.prompt) {
        return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Uploaded source is missing original prompt" } }, { status: 400 });
      }
      uploadedVersions.push({ storage_path: source.storage_path, prompt: source.prompt });
    }
  }

  const { data: references } = await supabase.from("style_references").select("storage_path").eq("style_id", styleId).order("created_at");
  const referenceUrls = await Promise.all((references ?? []).slice(0, 4).map(async (reference) => {
    const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(reference.storage_path, 300);
    return data?.signedUrl ?? null;
  }));
  const validReferenceUrls = referenceUrls.filter((url): url is string => Boolean(url));

  const generatedUrls = await Promise.all((versions ?? []).map(async (version) => {
    const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(version.storage_path, 300);
    return data?.signedUrl ?? null;
  }));
  const validGeneratedUrls = generatedUrls.filter((url): url is string => Boolean(url));

  const provenance = (versions ?? []).map((version, index) => ({
    versionId: version.id,
    originalPrompt: version.prompt ?? "[unknown]",
    compiledPrompt: (version.metadata as { compiled_prompt?: string })?.compiled_prompt ?? "[unknown]",
    model: (version.metadata as { model?: string })?.model ?? "[unknown]",
    generatedImageIndex: index,
  }));

  try {
    const targetUrls: string[] = [];
    const message = [
      `The first ${validGeneratedUrls.length} images are [GENERATED].`,
      uploadedVersions.length ? `The next ${uploadedVersions.length} images are [FEEDBACK].` : "No [FEEDBACK] images were supplied.",
      `The final ${validReferenceUrls.length} images are [REFERENCE].`,
      `Current prompt context: ${JSON.stringify(style.schema ?? {})}`,
      `Generation provenance: ${JSON.stringify(provenance)}`,
      parsed.data.feedback ? `User feedback: ${parsed.data.feedback}` : "",
    ].filter(Boolean).join("\n");

    const suggestion = await runStyleVisionAction({
      client: supabase,
      workspaceId: style.workspace_id,
      systemPrompt: REFINE_PROMPT_SYSTEM,
      userMessage: message,
      imageUrls: [...validGeneratedUrls, ...uploadedVersions.map((source) => source.storage_path), ...validReferenceUrls],
    });
    const suggestionRecord = suggestion as Record<string, unknown>;
    const issues = Array.isArray(suggestionRecord.issues) ? suggestionRecord.issues : [];
    const changes = Array.isArray(suggestionRecord.changes) ? suggestionRecord.changes : [];
    const lastFidelity = { drift_summary: suggestionRecord.drift_summary ?? "", confidence: suggestionRecord.confidence ?? "", issues, changes, evaluatedAt: new Date().toISOString() };

    const { data: proposal, error: proposalError } = await supabase.from("style_proposals").insert({
      style_id: styleId,
      base_updated_at: style.updated_at,
      kind: "tuning",
      payload: { evidence: lastFidelity, issues, changes },
      created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
    }).select().single();
    if (proposalError) {
      return NextResponse.json({ error: { code: "SAVE_FAILED", message: proposalError.message } }, { status: 500 });
    }

    return NextResponse.json({
      proposal: { id: proposal.id, baseUpdatedAt: proposal.base_updated_at, drift_summary: suggestionRecord.drift_summary ?? "", confidence: suggestionRecord.confidence ?? "", issues, changes },
    });
  } catch (error) {
    return NextResponse.json({ error: { code: "STYLE_ANALYSIS_FAILED", message: error instanceof Error ? error.message : "Tuning failed" } }, { status: 502 });
  }
}
