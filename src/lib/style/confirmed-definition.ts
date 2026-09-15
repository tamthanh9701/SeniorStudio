import { z } from "zod";
import { PromptSchemaSchema } from "./generation-packet";

/**
 * Durable, server-derived definition of a style.
 *
 * The confirmed definition is the only authority for new generation.  The
 * mutable `styles.schema` (candidate) keeps serving review and editing and is
 * never read at enqueue time.
 */
export const ConfirmedReferenceSchema = z
  .object({
    id: z.string().uuid(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();

export const ConfirmedStyleDefinitionSchema = z
  .object({
    definition_version: z.literal(1),
    style_revision: z.string().uuid(),
    schema_snapshot: PromptSchemaSchema,
    reference_snapshot: z.array(ConfirmedReferenceSchema).min(1).max(8),
    confirmed_at: z.string().min(1),
  })
  .strict();

export type ConfirmedStyleDefinition = z.infer<typeof ConfirmedStyleDefinitionSchema>;
export type ConfirmedReference = z.infer<typeof ConfirmedReferenceSchema>;

/**
 * Parse a `styles.confirmed_definition` value.  A definition that is present
 * but malformed must fail loudly instead of being treated as absent: silently
 * falling back to the mutable candidate would generate from an unconfirmed
 * definition.
 */
export function parseConfirmedDefinition(value: unknown): ConfirmedStyleDefinition | null {
  if (value === null || value === undefined) return null;
  const parsed = ConfirmedStyleDefinitionSchema.safeParse(value);
  if (!parsed.success) throw new Error("STYLE_DEFINITION_INVALID");
  const ids = new Set(parsed.data.reference_snapshot.map((reference) => reference.id));
  if (ids.size !== parsed.data.reference_snapshot.length) throw new Error("STYLE_DEFINITION_INVALID");
  return parsed.data;
}

export type StyleSetupState = "references" | "analysis" | "review" | "ready";

/**
 * Ordered setup states used by the workspace stepper.
 *
 * A confirmed style stays `ready` while its candidate is edited: generation
 * keeps using the confirmed definition until the change is confirmed again.
 */
export function getStyleSetupState(
  style: { status?: string | null; schema?: unknown; analysis_meta?: unknown; confirmed_definition?: unknown } | null | undefined,
  liveReferenceCount: number,
): StyleSetupState {
  if (!style) return "references";
  let confirmed = false;
  try {
    confirmed = parseConfirmedDefinition(style.confirmed_definition ?? null) !== null;
  } catch {
    confirmed = false;
  }
  if (confirmed && style.status === "active") return "ready";
  if (liveReferenceCount < 1) return "references";
  const meta = (style.analysis_meta ?? {}) as Record<string, unknown>;
  const analyzed = typeof meta.analyzedAt === "string" && meta.analyzedAt.length > 0;
  const snapshot = meta.reference_snapshot;
  const candidateReady = Boolean(style.schema && typeof style.schema === "object" && Object.keys(style.schema as Record<string, unknown>).length > 0);
  if (!analyzed || !candidateReady || !Array.isArray(snapshot)) return "analysis";
  return "review";
}

/**
 * Whether the analysed candidate still describes the live reference set.
 * Analysis records the analysed snapshot; any later add/retire makes it stale.
 */
export function isAnalysisStale(
  analysisMeta: unknown,
  liveReferences: ReadonlyArray<{ id: string; content_hash: string | null }>,
): boolean {
  const meta = (analysisMeta ?? {}) as Record<string, unknown>;
  const snapshot = meta.reference_snapshot;
  if (!Array.isArray(snapshot)) return true;
  if (snapshot.length !== liveReferences.length) return true;
  const recorded = new Map<string, string>();
  for (const entry of snapshot) {
    if (!entry || typeof entry !== "object") return true;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string") return true;
    recorded.set(record.id, typeof record.content_hash === "string" ? record.content_hash.toLowerCase() : "");
  }
  return liveReferences.some((reference) => recorded.get(reference.id) !== (reference.content_hash ?? "").toLowerCase());
}
