import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { enforceAiQuota } from "@/lib/ai/quota";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { normalizeStyleClarificationAnswers, makeStyleClarificationAnswerSet } from "@/lib/style/clarification-answers";
import type { StyleClarificationQuestionSet } from "@/lib/style/clarification-questions";
import { buildStyleClarificationQuestions } from "@/lib/style/clarification-questions";
import { buildStyleSchemaValidationPatch } from "@/lib/style/schema-validator";
import { applyStyleSchemaPatch } from "@/lib/style/schema-patch";
import { lintAndFixStyleSchema } from "@/lib/style/linter";
import { buildStyleInvariantContract, critiqueStyleSchema, type StyleInvariantContract } from "@/lib/style/invariant-contract";
import { commitStyleSchemaMutation } from "@/lib/style/schema-versions";
import { scoreStyleOperability } from "@/lib/style/operability-scorer";
import type { PromptSchema } from "@/lib/style/prompt-schema";

const ValidateSchema = z.object({ answers: z.unknown() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const quota = await enforceAiQuota(request, "brain");
  if (!quota.ok) return quota.response;
  const { styleId } = await params;
  const supabase = await createClient();
  const parsed = ValidateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const { data: style } = await supabase
    .from("styles")
    .select("schema, clarification_questions, invariant_contract, updated_at")
    .eq("id", styleId)
    .maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const questions = style.clarification_questions as StyleClarificationQuestionSet | null;
  if (!questions) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Style has no clarification questions" } }, { status: 400 });
  const normalized = normalizeStyleClarificationAnswers({ questions, rawAnswers: parsed.data.answers });
  if (!normalized.ok) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: normalized.errors.join(" "), details: normalized } }, { status: 400 });
  }

  const validation = buildStyleSchemaValidationPatch({
    draftSchema: style.schema,
    draftContract: style.invariant_contract as StyleInvariantContract | null,
    answers: normalized.answers,
  });
  const patched = applyStyleSchemaPatch(style.schema ?? {}, validation.patch);
  const lintResult = lintAndFixStyleSchema(patched as PromptSchema);
  const fingerprint = lintResult.fingerprint;
  const contract = buildStyleInvariantContract({ schema: lintResult.schema, fingerprint });
  const quality = critiqueStyleSchema({ schema: lintResult.schema, contract });
  const remainingQuestions = quality.overall >= 0.72
    ? null
    : buildStyleClarificationQuestions({ schema: lintResult.schema, contract, schemaQuality: quality });
  const answerSet = makeStyleClarificationAnswerSet(normalized.answers);

  const operability = scoreStyleOperability({ promptSchema: lintResult.schema as unknown as Record<string, unknown> });
  
  try {
    const updated = await commitStyleSchemaMutation(supabase, {
      styleId,
      expectedUpdatedAt: style.updated_at,
      source: "user_validation",
      schema: lintResult.schema as unknown as Record<string, unknown>,
      fingerprint: fingerprint as unknown as Record<string, unknown>,
      invariantContract: contract as unknown as Record<string, unknown>,
      styleFields: {
        clarification_questions: remainingQuestions,
        clarification_answers: answerSet,
        operability,
      },
      metadata: { qualityScore: quality.overall, changes: validation.patch, answers: answerSet },
    });
    return NextResponse.json({ style: updated, quality, changes: validation.patch, answers: answerSet, remainingQuestions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("STYLE_VERSION_CONFLICT")) {
      return NextResponse.json({ error: { code: "STYLE_VERSION_CONFLICT", message: "Style was modified since you started editing" } }, { status: 409 });
    }
    return NextResponse.json({ error: { code: "UPDATE_FAILED", message } }, { status: 500 });
  }
}
