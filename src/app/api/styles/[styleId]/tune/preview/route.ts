// Preview of a tuning proposal: apply the suggested changes to a copy of the
// schema and compile the prompt it would produce. Nothing is written.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { applyStyleSchemaPatch, type StyleSchemaPatch } from "@/lib/style/schema-patch";
import { lintAndFixStyleSchema } from "@/lib/style/linter";
import { buildStyleInvariantContract, critiqueStyleSchema } from "@/lib/style/invariant-contract";
import { scoreStyleOperability } from "@/lib/style/operability-scorer";
import { parseConfirmedDefinition } from "@/lib/style/confirmed-definition";
import { previewCompiledPrompt } from "@/lib/style/generation-packet";
import type { PromptSchema } from "@/lib/style/prompt-schema";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const ChangeSchema = z.object({
  group: z.string().min(1),
  field: z.string().min(1),
  suggested_value: z.unknown(),
}).strict();
const PreviewSchema = z.object({ changes: z.array(ChangeSchema).min(1) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = PreviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("schema, confirmed_definition").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  const patches: StyleSchemaPatch[] = parsed.data.changes.map((change) => ({
    op: "set",
    path: `${change.group}.${change.field}`,
    value: change.suggested_value,
    reason: "prompt_preview",
    source_question_ids: [],
    confidence: 1,
  }));

  try {
    // The prompt is compiled against the references the style was confirmed
    // with, so the preview shows what a generation would actually send.
    const definition = parseConfirmedDefinition(style.confirmed_definition);
    if (!definition) throw new Error("STYLE_SOURCE_SNAPSHOT_REQUIRED");
    const references = definition.reference_snapshot;
    const before = previewCompiledPrompt({
      schema: (style.schema ?? {}) as Record<string, unknown>,
      references,
    });
    const patched = applyStyleSchemaPatch(style.schema ?? {}, patches);
    const lintResult = lintAndFixStyleSchema(patched as PromptSchema);
    const after = previewCompiledPrompt({
      schema: lintResult.schema as unknown as Record<string, unknown>,
      references,
    });
    const fingerprint = lintResult.fingerprint;
    const contract = buildStyleInvariantContract({ schema: lintResult.schema, fingerprint });
    const quality = critiqueStyleSchema({ schema: lintResult.schema, contract });
    const operability = scoreStyleOperability({ promptSchema: lintResult.schema as unknown as Record<string, unknown> });
    return NextResponse.json({ compiledPromptBefore: before, compiledPromptAfter: after, quality, operability, issues: lintResult.issues ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message } }, { status: 400 });
  }
}
