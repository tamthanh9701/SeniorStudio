// The Game UI style contract: what a reference set says about buttons, bars,
// panels and their look.  It is deliberately not PromptSchema - that schema
// describes a subject in a scene, and forcing UI components through it lost the
// distinction between "look" (reusable) and "screen content" (per screen).
import { z } from "zod";

import { ELEMENT_KINDS, type ElementKind } from "./taxonomy";

export const GAME_UI_STYLE_SCHEMA_VERSION = 1;

const text = (max: number) => z.string().trim().max(max);
const requiredText = (max: number) => z.string().trim().min(1).max(max);

export const PaletteRoleSchema = z.enum([
  "background",
  "surface",
  "primary",
  "secondary",
  "accent",
  "text",
  "muted",
  "success",
  "warning",
  "danger",
  "custom",
]);

export const TypographyRoleSchema = z.enum(["title", "heading", "body", "caption", "numeric", "button"]);

export const PaletteTokenSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Palette ids are lowercase slugs"),
    role: PaletteRoleSchema,
    color: z.string().trim().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i, "Colors are #RRGGBB or #RRGGBBAA"),
    notes: text(500),
  })
  .strict();

export const TypographyRuleSchema = z
  .object({
    role: TypographyRoleSchema,
    family_description: text(1000),
    weight: text(100),
    casing: z.enum(["unchanged", "uppercase", "lowercase", "title"]),
    effects: text(500),
  })
  .strict();

export const LayoutRulesSchema = z
  .object({
    density: z.enum(["compact", "balanced", "spacious"]),
    spacing_rules: text(1000),
    alignment_rules: text(1000),
    safe_area_rules: text(1000),
    hierarchy_rules: text(1000),
  })
  .strict();

export const ShapeRulesSchema = z
  .object({ corner_rules: text(1000), border_rules: text(1000), silhouette_rules: text(1000) })
  .strict();

export const SurfaceRulesSchema = z
  .object({ materials: text(1000), shading: text(1000), shadows: text(1000), highlights: text(1000) })
  .strict();

export const IconographyRulesSchema = z
  .object({ construction: text(1000), stroke_rules: text(1000), detail_level: text(1000) })
  .strict();

export const ComponentStyleSchema = z
  .object({
    kind: z.enum(ELEMENT_KINDS),
    appearance: text(1000),
    text_rules: text(1000),
    composition_rules: text(1000),
  })
  .strict();

export const GameUiStyleSchemaV1 = z
  .object({
    schema_version: z.literal(GAME_UI_STYLE_SCHEMA_VERSION),
    domain: z.literal("game_ui"),
    name: requiredText(100),
    visual_language: requiredText(2000),
    palette: z.array(PaletteTokenSchema).min(1).max(32),
    typography: z.array(TypographyRuleSchema).min(1).max(12),
    layout: LayoutRulesSchema,
    shape: ShapeRulesSchema,
    surface: SurfaceRulesSchema,
    iconography: IconographyRulesSchema,
    components: z.array(ComponentStyleSchema).min(1).max(32),
    invariants: z.array(requiredText(500)).min(1).max(30),
    avoid: z.array(requiredText(500)).max(30),
    uncertainties: z.array(z.object({ field: requiredText(200), question: requiredText(500) }).strict()).max(30),
  })
  .strict();

export type GameUiStyleSchema = z.infer<typeof GameUiStyleSchemaV1>;
export type PaletteToken = z.infer<typeof PaletteTokenSchema>;
export type ComponentStyle = z.infer<typeof ComponentStyleSchema>;

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Parse an analyzed or hand-edited candidate.  Every failure names the field at
 * fault: the review screen shows this text, and "invalid schema" alone left the
 * user with nothing to fix.
 */
export function parseGameUiStyleSchema(value: unknown): GameUiStyleSchema {
  const parsed = GameUiStyleSchemaV1.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "schema";
    throw new Error(`INVALID_GAME_UI_STYLE_SCHEMA: ${path}: ${issue?.message ?? "invalid"}`);
  }
  const schema = parsed.data;
  const duplicateTokens = duplicateValues(schema.palette.map((token) => token.id));
  if (duplicateTokens.length > 0) throw new Error(`INVALID_GAME_UI_STYLE_SCHEMA: duplicate palette ids ${duplicateTokens.join(", ")}`);
  const duplicateComponents = duplicateValues(schema.components.map((component) => component.kind));
  if (duplicateComponents.length > 0) throw new Error(`INVALID_GAME_UI_STYLE_SCHEMA: duplicate components ${duplicateComponents.join(", ")}`);
  return schema;
}

/**
 * Not blocking, but worth showing before a style is confirmed: an uncertainty the
 * analysis itself recorded, or a component it could not describe.
 */
export function gameUiStyleWarnings(schema: GameUiStyleSchema): string[] {
  const warnings = schema.uncertainties.map((entry) => `${entry.field}: ${entry.question}`);
  for (const component of schema.components) {
    if (!component.appearance.trim()) warnings.push(`${component.kind}: the reference set did not show this component's appearance`);
  }
  if (schema.palette.length < 3) warnings.push("Fewer than three palette tokens: generated screens have little color guidance");
  return warnings;
}

/** Components whose look the reference set actually showed, for coverage checks. */
export function styledComponentKinds(schema: GameUiStyleSchema): ElementKind[] {
  return schema.components.filter((component) => component.appearance.trim().length > 0).map((component) => component.kind);
}

/** Reuse of an existing visual-style helper: the grade vocabulary is shared. */
export function gameUiStyleGrade(schema: GameUiStyleSchema): "production_ready" | "usable_with_warnings" {
  return gameUiStyleWarnings(schema).length === 0 ? "production_ready" : "usable_with_warnings";
}
