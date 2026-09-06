// Ported from Restyle commit dfab2fea903923e4a19171cc4a2eb4cf4144d8ae
// (src/lib/normalizeAiResult.ts). Import paths adjusted only.
import { toStringArray } from './prompt-schema';
import { lintAndFixStyleSchema } from './linter';

// Normalize AI-produced PromptSchema JSON at the analyze boundary.
//
// The model is an UNTRUSTED source for SHAPE: it may return a string where the
// schema declares string[] (e.g. dominant_colors: "red, blue" instead of
// ["red","blue"]). Downstream code does `.join()` / `.map()` on those fields and
// crashes ("x.join is not a function").
//
// CONTRACT: this function NEVER throws and NEVER rejects. AI output is messy;
// a validator that rejects would block all generation — worse than the bug.
// It coerces the known array fields into string[] and then runs a conservative
// semantic linter for common style drift risks. If the input isn't an object,
// it's returned as-is.

/** Array (string[]) fields in PromptSchema, by group, that the model often returns as a string. */
const ARRAY_FIELDS: Record<string, string[]> = {
  color_palette: ['dominant_colors'],
  negative_prompt: ['avoid_elements', 'avoid_styles', 'avoid_artifacts', 'avoid_quality'],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Coerce the known string[] fields of a (possibly malformed) PromptSchema-like
 * object into real string arrays. Defensive: never throws, never rejects.
 */
export function normalizePromptSchema(input: unknown): unknown {
  if (!isPlainObject(input)) return input;

  for (const [group, fields] of Object.entries(ARRAY_FIELDS)) {
    const g = input[group];
    if (!isPlainObject(g)) continue;
    for (const field of fields) {
      if (field in g) {
        // toStringArray handles array | string | null | other -> string[]
        g[field] = toStringArray(g[field]);
      }
    }
  }

  // Run the semantic lint pass without reference stats at the analyze boundary.
  // The analyze service runs the same linter again with richer reference
  // metadata, so this pass intentionally only applies generic safe fixes.
  try {
    return lintAndFixStyleSchema(input).schema;
  } catch {
    return input;
  }
}
