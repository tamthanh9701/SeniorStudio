import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, getServiceClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { resolveStyleProviderConfig } from "@/lib/style/providers/config";
import { GoogleStyleProvider } from "@/lib/style/providers/google";
import { OpenAiStyleProvider } from "@/lib/style/providers/openai";
import type { StyleAnalysisProvider } from "@/lib/style/providers/types";
import { buildAnalysisUserMessage, stripMarkdownFence } from "@/lib/style/providers/prompts";
import { preprocessReferences, type ReferenceInput } from "@/lib/style/reference-preprocess";
import { normalizePromptSchema } from "@/lib/style/normalize-prompt-schema";
import { lintAndFixStyleSchema } from "@/lib/style/linter";
import { StyleError, styleErrorStatus } from "@/lib/style/errors";
import { enforceAiQuota } from "@/lib/ai/quota";

const SynthesizeSchema = z.object({
  expectedUpdatedAt: z.string().min(1),
  userWishes: z.string().trim().max(3000).optional(),
  answers: z.unknown().optional(),
}).strict();

export const maxDuration = 180;

const SYNTHESIS_SYSTEM = `You are a style synthesis expert. Given a current style schema, user wishes, and optional clarification answers, produce an improved schema that better matches the user's intent.

Return ONLY valid JSON with this structure:
{
  "schema": { ... PromptSchema fields ... },
  "summary": "string describing what changed and why",
  "conflicts": [{ "field": "string", "description": "string" }]
}

Conflicts are required when user wishes contradict the current style or are too vague to resolve. Each conflict identifies one field where the user's request is ambiguous or contradictory.
If there are no conflicts, return an empty array.

IMPORTANT: The schema must be valid PromptSchema format. Use null for unknown fields.
Use the same style_name, version, and subject_type as the original unless the user explicitly requests a change.`;

function isJsonSafe(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonSafe);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonSafe);
  return false;
}

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const parsed = SynthesizeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: parsed.error.message } }, { status: 400 });

  const { data: style } = await supabase.from("styles").select("id, name, status, schema, updated_at, workspace_id").eq("id", styleId).single();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });

  if (parsed.data.expectedUpdatedAt !== style.updated_at) {
    return NextResponse.json({ error: { code: "STYLE_VERSION_CONFLICT", message: "Style was modified since you started editing" } }, { status: 409 });
  }

  const quota = await enforceAiQuota(request, "brain");
  if (!quota.ok) return quota.response;

  const { data: references } = await supabase.from("style_references").select("id, storage_path, mime_type, byte_size, content_hash").eq("style_id", styleId).order("created_at");
  if (!references?.length) return NextResponse.json({ error: { code: "NO_REFERENCES", message: "Upload at least one reference image before synthesizing" } }, { status: 400 });

  const service = getServiceClient();
  const referenceBytes: ReferenceInput[] = await Promise.all(
    references.map(async (ref) => {
      const { data: file } = await service.storage.from("assets").download(ref.storage_path);
      if (!file) throw new StyleError("FILE_UNAVAILABLE", `Could not download reference ${ref.id}`);
      return { id: ref.id, buffer: Buffer.from(await file.arrayBuffer()), mimeType: ref.mime_type };
    }),
  );
  const referenceSummary = await preprocessReferences(referenceBytes);

  try {
    const config = await resolveStyleProviderConfig({ user: supabase, service, workspaceId: style.workspace_id });
    const provider: StyleAnalysisProvider = config.provider === "google"
      ? new GoogleStyleProvider(config.apiKey, config.model)
      : new OpenAiStyleProvider(config.apiKey, config.model);
    const userMessage = buildAnalysisUserMessage({
      styleName: style.name,
      referenceCount: references.length,
      userContext: [
        parsed.data.userWishes ? `User wishes: ${parsed.data.userWishes}` : "",
        parsed.data.answers ? `User answers: ${JSON.stringify(parsed.data.answers)}` : "",
      ].filter(Boolean).join("\n") || undefined,
      referenceSummary,
    });
    const result = await provider.analyze({
      references: referenceBytes.map(({ buffer, mimeType }) => ({ buffer, mimeType })),
      systemPrompt: SYNTHESIS_SYSTEM,
      userMessage: `Current schema:\n${JSON.stringify(style.schema ?? {}, null, 2)}\n\n${userMessage}`,
      referenceSummary,
      timeoutMs: 150_000,
    });

    let candidate: unknown;
    try {
      candidate = JSON.parse(stripMarkdownFence(result.rawText));
    } catch {
      throw new StyleError("STYLE_ANALYSIS_UNPARSED", "Synthesis reply was not valid JSON");
    }

    const summary = typeof (candidate as Record<string, unknown>)?.summary === "string" ? (candidate as Record<string, unknown>).summary : "";
    const conflicts = Array.isArray((candidate as Record<string, unknown>)?.conflicts) ? (candidate as Record<string, unknown>).conflicts : [];
    const schema = (candidate as Record<string, unknown>)?.schema;
    if (!schema || typeof schema !== "object") throw new StyleError("STYLE_ANALYSIS_UNPARSED", "Synthesis reply did not contain a valid schema");

    const normalized = normalizePromptSchema(schema);
    if (!isJsonSafe(normalized)) throw new StyleError("STYLE_ANALYSIS_UNPARSED", "Synthesis schema contains unsafe values");

    const { data: proposal, error: insertError } = await supabase.from("style_proposals").insert({
      style_id: styleId,
      base_updated_at: style.updated_at,
      kind: "synthesis",
      payload: { candidate_schema: normalized, summary, conflicts, user_wishes: parsed.data.userWishes ?? "", answers: parsed.data.answers ?? null },
      created_by: user.id,
    }).select().single();

    if (insertError) {
      if (insertError.message.includes("style_version_conflict") || insertError.code === "23505") {
        return NextResponse.json({ error: { code: "STYLE_VERSION_CONFLICT", message: "Style was modified during synthesis" } }, { status: 409 });
      }
      return NextResponse.json({ error: { code: "SAVE_FAILED", message: insertError.message } }, { status: 500 });
    }

    return NextResponse.json({ proposal: { id: proposal.id, baseUpdatedAt: proposal.base_updated_at, summary, conflicts, schema: normalized } }, { status: 201 });
  } catch (error) {
    if (error instanceof StyleError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: styleErrorStatus(error.code) });
    }
    return NextResponse.json({ error: { code: "STYLE_ANALYSIS_FAILED", message: error instanceof Error ? error.message : "Synthesis failed" } }, { status: 502 });
  }
}
