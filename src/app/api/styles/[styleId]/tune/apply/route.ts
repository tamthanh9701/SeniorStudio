import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { applyStyleSchemaPatch, type StyleSchemaPatch } from "@/lib/style/schema-patch";
import { lintAndFixStyleSchema } from "@/lib/style/linter";
import { buildStyleInvariantContract, critiqueStyleSchema } from "@/lib/style/invariant-contract";
import { commitStyleSchemaMutation } from "@/lib/style/schema-versions";
import { scoreStyleOperability } from "@/lib/style/operability-scorer";
import type { PromptSchema } from "@/lib/style/prompt-schema";

const ChangeSchema = z.object({
  group: z.string().min(1),
  field: z.string().min(1),
  suggested_value: z.unknown(),
}).strict();
const ApplySchema = z.object({ changes: z.array(ChangeSchema).min(1) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = ApplySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("schema, updated_at").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });
  const patches: StyleSchemaPatch[] = parsed.data.changes.map((change) => ({
    op: "set",
    path: `${change.group}.${change.field}`,
    value: change.suggested_value,
    reason: "user_tuning",
    source_question_ids: [],
    confidence: 1,
  }));

  try {
    const patched = applyStyleSchemaPatch(style.schema ?? {}, patches);
    const lintResult = lintAndFixStyleSchema(patched as PromptSchema);
    const fingerprint = lintResult.fingerprint;
    const contract = buildStyleInvariantContract({ schema: lintResult.schema, fingerprint });
    const quality = critiqueStyleSchema({ schema: lintResult.schema, contract });
    const operability = scoreStyleOperability({ promptSchema: lintResult.schema as unknown as Record<string, unknown> });
    const updated = await commitStyleSchemaMutation(supabase, {
      styleId,
      expectedUpdatedAt: style.updated_at,
      source: "tuning",
      schema: lintResult.schema as unknown as Record<string, unknown>,
      fingerprint: fingerprint as unknown as Record<string, unknown>,
      invariantContract: contract as unknown as Record<string, unknown>,
      styleFields: { operability },
      metadata: { appliedChanges: parsed.data.changes, qualityScore: quality.overall },
    });
    return NextResponse.json({ style: updated, quality });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("STYLE_VERSION_CONFLICT")) {
      return NextResponse.json({ error: { code: "STYLE_VERSION_CONFLICT", message: "Style was modified since you started editing" } }, { status: 409 });
    }
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message } }, { status: 400 });
  }
}
