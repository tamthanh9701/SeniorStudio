import { MAX_STYLE_REFERENCES } from "./reference-limits";
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
    reference_snapshot: z.array(ConfirmedReferenceSchema).min(1).max(MAX_STYLE_REFERENCES),
    confirmed_at: z.string().min(1),
  })
  .strict();

/**
 * A Game UI style confirms as definition version 2 and names its domain, so a
 * version 1 definition can never be read as a Game UI style and vice versa.
 * The visual schema lives in the other module because it is the other module's
 * contract; importing it here would make the generic style code depend on UI
 * taxonomy.
 */
export const ConfirmedGameUiDefinitionSchema = z
  .object({
    definition_version: z.literal(2),
    domain: z.literal("game_ui"),
    style_revision: z.string().uuid(),
    schema_snapshot: z.record(z.string(), z.unknown()),
    reference_snapshot: z.array(ConfirmedReferenceSchema).min(1).max(MAX_STYLE_REFERENCES),
    confirmed_at: z.string().min(1),
  })
  .strict();

export type ConfirmedStyleDefinition = z.infer<typeof ConfirmedStyleDefinitionSchema>;
export type ConfirmedGameUiDefinition = z.infer<typeof ConfirmedGameUiDefinitionSchema>;
export type ConfirmedReference = z.infer<typeof ConfirmedReferenceSchema>;

/** Which domain a stored definition belongs to; null when there is none. */
export function confirmedDefinitionDomain(value: unknown): "visual" | "game_ui" | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("STYLE_DEFINITION_INVALID");
  const record = value as Record<string, unknown>;
  const version = record.definition_version;
  if (version === 1) return "visual";
  if (version === 2) {
    if (record.domain !== "game_ui") throw new Error("STYLE_DEFINITION_INVALID");
    return "game_ui";
  }
  throw new Error("STYLE_DEFINITION_INVALID");
}

/**
 * Parse a Game UI confirmed definition.  Like the visual parser, a definition
 * that is present but malformed fails loudly instead of reading as absent.
 */
export function parseGameUiConfirmedDefinition(value: unknown): ConfirmedGameUiDefinition | null {
  if (value === null || value === undefined) return null;
  const parsed = ConfirmedGameUiDefinitionSchema.safeParse(value);
  if (!parsed.success) throw new Error("STYLE_DEFINITION_INVALID");
  const ids = new Set(parsed.data.reference_snapshot.map((reference) => reference.id));
  if (ids.size !== parsed.data.reference_snapshot.length) throw new Error("STYLE_DEFINITION_INVALID");
  return parsed.data;
}

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
    // A Game UI style confirms as definition version 2, which the visual parser
    // rejects; asking the domain first keeps a confirmed Game UI style "ready"
    // instead of silently reporting it as still under review.
    confirmed =
      confirmedDefinitionDomain(style.confirmed_definition ?? null) === "game_ui"
        ? parseGameUiConfirmedDefinition(style.confirmed_definition ?? null) !== null
        : parseConfirmedDefinition(style.confirmed_definition ?? null) !== null;
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
