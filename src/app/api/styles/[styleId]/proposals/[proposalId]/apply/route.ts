import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, getServiceClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { lintAndFixStyleSchema } from "@/lib/style/linter";
import { buildStyleInvariantContract, critiqueStyleSchema } from "@/lib/style/invariant-contract";
import { scoreStyleOperability } from "@/lib/style/operability-scorer";
import type { PromptSchema } from "@/lib/style/prompt-schema";
import { applyStyleSchemaPatch, type StyleSchemaPatch } from "@/lib/style/schema-patch";
import { StyleError, styleErrorStatus } from "@/lib/style/errors";

const ApplySchema = z.object({
  selectedChangeIds: z.array(z.string()),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string; proposalId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const { styleId, proposalId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = ApplySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  try {
    const { data: style } = await supabase.from("styles").select("id, schema, fingerprint, invariant_contract, updated_at, status, workspace_id").eq("id", styleId).single();
    if (!style) throw new StyleError("STYLE_NOT_FOUND", "Style not found");

    const { data: proposal } = await supabase.from("style_proposals").select("*").eq("id", proposalId).eq("style_id", styleId).single();
    if (!proposal) throw new StyleError("STYLE_NOT_FOUND", "Proposal not found");
    if (proposal.applied_at) throw new StyleError("STYLE_CONFLICT", "Proposal already applied");
    if (proposal.base_updated_at !== style.updated_at) throw new StyleError("STYLE_VERSION_CONFLICT", "Style was modified since proposal was created");

    const service = getServiceClient();
    if (proposal.kind === "synthesis") {
      const payload = proposal.payload as Record<string, unknown>;
      const candidateSchema = payload.candidate_schema as Record<string, unknown>;
      if (!candidateSchema || typeof candidateSchema !== "object") throw new StyleError("INVALID_REQUEST", "No candidate schema in proposal");
      if (parsed.data.selectedChangeIds.length > 0) throw new StyleError("INVALID_REQUEST", "Synthesis proposals cannot select specific changes");

      const lintResult = lintAndFixStyleSchema(candidateSchema as unknown as PromptSchema);
      const fingerprint = lintResult.fingerprint;
      const contract = buildStyleInvariantContract({ schema: lintResult.schema, fingerprint });
      const quality = critiqueStyleSchema({ schema: lintResult.schema, contract });
      if (quality.overall < 0.72 && style.status === "active") {
        throw new StyleError("STYLE_NOT_READY", "Style quality below threshold for activation");
      }
      const operability = scoreStyleOperability({ promptSchema: lintResult.schema as unknown as Record<string, unknown> });

      await service.rpc("commit_style_schema_mutation", {
        p_style_id: styleId,
        p_expected_updated_at: style.updated_at,
        p_source: "user_validation",
        p_schema: lintResult.schema,
        p_fingerprint: fingerprint,
        p_invariant_contract: contract,
        p_style_fields: { operability },
        p_metadata: { proposalId, wishes: payload.user_wishes },
      });

      await supabase.from("style_proposals").update({ applied_at: new Date().toISOString() }).eq("id", proposalId);
      return NextResponse.json({ ok: true });
    }

    // tuning proposal
    const payload = proposal.payload as Record<string, unknown>;
    const changes = (payload.changes ?? []) as Array<{ id: string; group: string; field: string; suggested_value: unknown; reason: string }>;
    if (parsed.data.selectedChangeIds.length === 0) throw new StyleError("INVALID_REQUEST", "Select at least one change to apply");
    const changeById = new Map(changes.map((c) => [c.id, c]));
    const selectedPatches: StyleSchemaPatch[] = [];
    for (const id of parsed.data.selectedChangeIds) {
      const change = changeById.get(id);
      if (!change) throw new StyleError("INVALID_REQUEST", `Change ${id} not found in proposal`);
      selectedPatches.push({ op: "set", path: `${change.group}.${change.field}`, value: change.suggested_value, reason: "tuning_proposal", source_question_ids: [], confidence: 1 });
    }

    const patched = applyStyleSchemaPatch(style.schema ?? {}, selectedPatches);
    const lintResult = lintAndFixStyleSchema(patched as unknown as PromptSchema);
    const fingerprint = lintResult.fingerprint;
    const contract = buildStyleInvariantContract({ schema: lintResult.schema, fingerprint });
    const quality = critiqueStyleSchema({ schema: lintResult.schema, contract });
    const operability = scoreStyleOperability({ promptSchema: lintResult.schema as unknown as Record<string, unknown> });

    await service.rpc("commit_style_schema_mutation", {
      p_style_id: styleId,
      p_expected_updated_at: style.updated_at,
      p_source: "tuning",
      p_schema: lintResult.schema,
      p_fingerprint: fingerprint,
      p_invariant_contract: contract,
      p_style_fields: { operability },
      p_metadata: { proposalId, selectedChangeIds: parsed.data.selectedChangeIds },
    });

    await supabase.from("style_proposals").update({ applied_at: new Date().toISOString() }).eq("id", proposalId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof StyleError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: styleErrorStatus(error.code) });
    }
    return NextResponse.json({ error: { code: "UPDATE_FAILED", message: error instanceof Error ? error.message : "Failed to apply proposal" } }, { status: 500 });
  }
}
