// Analysis sends every reference image to the vision provider, and a style may
// hold 20 references of up to 5 MB each. The originals are re-encoded to a
// bounded working size first: the provider gains no accuracy from a 5 MB PNG,
// and the request would otherwise be refused for size.
//
// The reference quality report is computed from the originals before this runs,
// so resolution metrics stay truthful.
import sharp from "sharp";
import type { ReferenceInput } from "./reference-preprocess";

const DEFAULT_MAX_EDGE = 640;
const JPEG_QUALITY = 82;

/**
 * Returns copies resized to fit `maxEdge` on their longest side. Transparency is
 * preserved as PNG; everything else becomes JPEG. An image sharp cannot decode
 * is passed through unchanged so the provider reports the real problem.
 */
export async function downscaleReferences(
  inputs: readonly ReferenceInput[],
  maxEdge = DEFAULT_MAX_EDGE,
): Promise<ReferenceInput[]> {
  return Promise.all(
    inputs.map(async (input) => {
      try {
        const pipeline = sharp(input.buffer, { failOn: "error" }).rotate();
        const metadata = await pipeline.metadata();
        const resized = pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
        if (metadata.hasAlpha === true) {
          return { ...input, buffer: await resized.png({ compressionLevel: 9 }).toBuffer(), mimeType: "image/png" };
        }
        return { ...input, buffer: await resized.jpeg({ quality: JPEG_QUALITY }).toBuffer(), mimeType: "image/jpeg" };
      } catch {
        return input;
      }
    }),
  );
}
