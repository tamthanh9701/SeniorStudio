/**
 * Limits that describe a style reference image.
 *
 * The same numbers are enforced in several places that cannot import from each
 * other: this module (upload route, composer, schema cap) and the SQL functions
 * in `supabase/migrations` (the guard trigger, `add_style_reference`, the enqueue
 * snapshot check). Keeping the TypeScript side in one file means only the SQL
 * copies can drift, and those are covered by the database suite.
 */

/** How many references one style may hold. */
export const MAX_STYLE_REFERENCES = 20;

/** Largest upload accepted per file, in bytes. */
export const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;

/**
 * Most pixels a reference may contain. Decoding is what costs memory, and a 5 MB
 * PNG can describe 260 megapixels, so the gate is on the decoded size rather than
 * the file size.
 */
export const MAX_REFERENCE_PIXELS = 40_000_000;
