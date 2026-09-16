// Analysis sends every reference image to the vision provider, and a style may
// hold 20 references of up to 5 MB each. The originals are re-encoded to a
// bounded working size first: the provider gains no accuracy from a 5 MB PNG,
// and the request would otherwise be refused for size.
//
// The reference quality report is computed from the originals before this runs,
// so resolution metrics stay truthful.
import sharp from "sharp";
import { StyleError } from "./errors";
import { MAX_REFERENCE_PIXELS } from "./reference-limits";
import type { ReferenceInput } from "./reference-preprocess";

const DEFAULT_MAX_EDGE = 640;
const JPEG_QUALITY = 82;
/** Decoding is the expensive step; the same budget the upload route enforces. */
const MAX_DECODE_PIXELS = MAX_REFERENCE_PIXELS;
/** Two references at a time: twenty full decodes in parallel exhaust the instance. */
const DECODE_CONCURRENCY = 2;

/**
 * Returns copies resized to fit `maxEdge` on their longest side. Transparency is
 * preserved as PNG; everything else becomes JPEG.
 *
 * A reference whose own pixels exceed the decode budget is refused: sending it at
 * full size would either exhaust memory here or be rejected by the provider with a
 * message that says nothing about which reference caused it. Other decode failures
 * pass through unchanged, so the provider reports the real problem.
 */
export async function downscaleReferences(
  inputs: readonly ReferenceInput[],
  maxEdge = DEFAULT_MAX_EDGE,
): Promise<ReferenceInput[]> {
  const results: ReferenceInput[] = new Array(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      const input = inputs[index];
      try {
        const pipeline = sharp(input.buffer, { failOn: "error", limitInputPixels: MAX_DECODE_PIXELS }).rotate();
        const metadata = await pipeline.metadata();
        const resized = pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
        if (metadata.hasAlpha === true) {
          results[index] = { ...input, buffer: await resized.png({ compressionLevel: 9 }).toBuffer(), mimeType: "image/png" };
        } else {
          results[index] = { ...input, buffer: await resized.jpeg({ quality: JPEG_QUALITY }).toBuffer(), mimeType: "image/jpeg" };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/pixel limit/i.test(message)) {
          throw new StyleError("REFERENCE_TOO_LARGE", `Reference ${input.id} has too many pixels to analyze; replace it with a smaller image`);
        }
        results[index] = input;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DECODE_CONCURRENCY, inputs.length) }, worker));
  return results;
}
