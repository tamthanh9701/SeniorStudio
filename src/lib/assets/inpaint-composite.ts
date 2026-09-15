import sharp from "sharp";

export const MAX_DECODED_PIXELS = 100_000_000;
export const MAX_DECODED_BYTES = 50 * 1024 * 1024;

/**
 * Composite an edit result so everything outside the painted mask is the
 * original pixel data.
 *
 * The canonical mask convention (also produced by the mask editor) is RGBA
 * where alpha 255 marks a protected pixel and alpha 0 marks an editable one;
 * fractional alpha blends.  Providers honour masks to varying degrees, so the
 * invariant is enforced here rather than trusted to the model.
 *
 * Dimensions must match exactly: silently resizing would move the edit region.
 */
export async function compositeInpaintResult(
  sourceBytes: Uint8Array,
  generatedBytes: Uint8Array,
  maskBytes: Uint8Array,
): Promise<Uint8Array> {
  const decode = async (bytes: Uint8Array, label: string) => {
    const image = sharp(bytes, { failOn: "error" }).rotate().ensureAlpha().toColourspace("srgb");
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    if (info.width * info.height > MAX_DECODED_PIXELS) throw new Error(`${label} exceeds the pixel limit`);
    if (info.channels !== 4) throw new Error(`${label} could not be normalised to RGBA`);
    return { data, width: info.width, height: info.height };
  };

  const [source, generated, mask] = await Promise.all([
    decode(sourceBytes, "Source image"),
    decode(generatedBytes, "Generated image"),
    decode(maskBytes, "Mask"),
  ]);

  if (source.width !== generated.width || source.height !== generated.height) {
    throw new Error("INPAINT_DIMENSION_MISMATCH: the generated image does not match the source size");
  }
  if (source.width !== mask.width || source.height !== mask.height) {
    throw new Error("INPAINT_DIMENSION_MISMATCH: the mask does not match the source size");
  }

  const pixels = source.width * source.height;
  const merged = Buffer.allocUnsafe(pixels * 4);
  const src = source.data;
  const gen = generated.data;
  const msk = mask.data;
  let editable = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const protection = msk[offset + 3];
    if (protection === 255) {
      // Fully protected: copy the decoded original bytes unchanged.
      merged[offset] = src[offset];
      merged[offset + 1] = src[offset + 1];
      merged[offset + 2] = src[offset + 2];
      merged[offset + 3] = src[offset + 3];
      continue;
    }
    if (protection === 0) {
      merged[offset] = gen[offset];
      merged[offset + 1] = gen[offset + 1];
      merged[offset + 2] = gen[offset + 2];
      merged[offset + 3] = gen[offset + 3];
      editable += 1;
      continue;
    }
    // Fractional edge: premultiplied blend weighted by the edit share.
    const edit = (255 - protection) / 255;
    const keep = protection / 255;
    const alpha = gen[offset + 3] * edit + src[offset + 3] * keep;
    if (alpha <= 0) {
      merged[offset] = 0;
      merged[offset + 1] = 0;
      merged[offset + 2] = 0;
      merged[offset + 3] = 0;
      continue;
    }
    merged[offset] = Math.round((gen[offset] * gen[offset + 3] * edit + src[offset] * src[offset + 3] * keep) / alpha);
    merged[offset + 1] = Math.round((gen[offset + 1] * gen[offset + 3] * edit + src[offset + 1] * src[offset + 3] * keep) / alpha);
    merged[offset + 2] = Math.round((gen[offset + 2] * gen[offset + 3] * edit + src[offset + 2] * src[offset + 3] * keep) / alpha);
    merged[offset + 3] = Math.round(alpha);
    editable += 1;
  }
  if (editable === 0) {
    throw new Error("INPAINT_EMPTY_MASK: the mask does not cover any editable pixel");
  }

  const encoded = await sharp(merged, { raw: { width: source.width, height: source.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (encoded.byteLength > MAX_DECODED_BYTES) throw new Error("FILE_TOO_LARGE: the composited image exceeds the size limit");
  return new Uint8Array(encoded);
}
