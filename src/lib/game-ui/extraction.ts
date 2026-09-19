// Deterministic element extraction for exact mode. The exported PNG must be
// reproducible from the stored bounding box plus the user-painted matte alone,
// so this module never calls a provider, never resizes/trims and never reads
// the clock or randomness. Keeping the crop at box size preserves placement.
import sharp, { type Metadata } from "sharp";

import { GameUiError } from "./errors";

export type ExtractionInput = {
  sourceBytes: Uint8Array;
  matteBytes: Uint8Array;
  bounds: { x: number; y: number; width: number; height: number };
};

export type ExtractionResult = {
  png: Uint8Array;
  width: number;
  height: number;
  alphaStatus: "transparent" | "opaque";
  visiblePixels: number;
  transparentPixels: number;
};

const RGBA_CHANNELS = 4;

function assertBounds(bounds: ExtractionInput["bounds"]): void {
  const { x, y, width, height } = bounds;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new GameUiError("INVALID_REQUEST", "Element bounds must be whole source pixels");
  }
  if (width < 1 || height < 1) {
    throw new GameUiError("INVALID_REQUEST", "Element bounds must be at least 1x1 pixels");
  }
  if (x < 0 || y < 0) {
    throw new GameUiError("INVALID_REQUEST", "Element bounds origin must not be negative");
  }
}

/** Decode any supported input to 8-bit sRGB RGBA raw samples. */
async function decodeRgba(bytes: Uint8Array, options: { autoOrient: boolean }) {
  const pipeline = sharp(bytes, { failOn: "error" });
  if (options.autoOrient) pipeline.rotate();
  return pipeline
    .ensureAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
}

export async function extractElement(input: ExtractionInput): Promise<ExtractionResult> {
  const { sourceBytes, matteBytes, bounds } = input;
  assertBounds(bounds);

  // Type checks come first so a wrong file type is reported as such rather than
  // as a geometry mismatch. sharp rejects empty or malformed input
  // synchronously, so the probe has to catch both ways.
  let matteMeta: Metadata | null;
  try {
    matteMeta = await sharp(matteBytes, { failOn: "error" }).metadata();
  } catch {
    matteMeta = null;
  }
  if (matteMeta?.format !== "png") {
    throw new GameUiError("UNSUPPORTED_IMAGE_TYPE", "Extraction matte must be a PNG file");
  }
  if (matteMeta.hasAlpha !== true) {
    throw new GameUiError("UNSUPPORTED_IMAGE_TYPE", "Extraction matte must carry an alpha channel (RGBA PNG)");
  }

  // One rotated decode yields both the auto-oriented dimensions and the pixels.
  const source = await decodeRgba(sourceBytes, { autoOrient: true }).catch(() => null);
  if (
    !source ||
    source.info.channels !== RGBA_CHANNELS ||
    source.data.byteLength !== source.info.width * source.info.height * RGBA_CHANNELS
  ) {
    throw new GameUiError("INVALID_REQUEST", "Source image could not be decoded to 8-bit RGBA");
  }
  const sourceWidth = source.info.width;
  const sourceHeight = source.info.height;
  if (bounds.x + bounds.width > sourceWidth || bounds.y + bounds.height > sourceHeight) {
    throw new GameUiError(
      "INVALID_REQUEST",
      `Element bounds ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y} fall outside the ${sourceWidth}x${sourceHeight} source image`,
    );
  }

  const matte = await decodeRgba(matteBytes, { autoOrient: false }).catch(() => null);
  if (
    !matte ||
    matte.info.channels !== RGBA_CHANNELS ||
    matte.data.byteLength !== matte.info.width * matte.info.height * RGBA_CHANNELS
  ) {
    throw new GameUiError("UNSUPPORTED_IMAGE_TYPE", "Extraction matte could not be decoded to RGBA");
  }
  if (matte.info.width !== bounds.width || matte.info.height !== bounds.height) {
    throw new GameUiError(
      "INVALID_REQUEST",
      `Extraction matte is ${matte.info.width}x${matte.info.height} but the element box is ${bounds.width}x${bounds.height}`,
    );
  }

  const pixelCount = bounds.width * bounds.height;
  let matteKeepsPixels = false;
  for (let pixel = 0; pixel < pixelCount && !matteKeepsPixels; pixel += 1) {
    if (matte.data[pixel * RGBA_CHANNELS + 3] > 0) matteKeepsPixels = true;
  }
  if (!matteKeepsPixels) {
    throw new GameUiError("INVALID_REQUEST", "Extraction matte is fully transparent; there is nothing to keep");
  }

  const crop = await sharp(source.data, {
    raw: { width: sourceWidth, height: sourceHeight, channels: RGBA_CHANNELS },
  })
    .extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height })
    .raw()
    .toBuffer();

  const out = Buffer.alloc(pixelCount * RGBA_CHANNELS);
  let visiblePixels = 0;
  let transparentPixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * RGBA_CHANNELS;
    const matteAlpha = matte.data[offset + 3];
    // alpha_out = round(alpha_source * alpha_matte / 255); removed pixels stay
    // exactly 0,0,0,0 so no stale colour survives behind transparency.
    const alpha = matteAlpha === 0 ? 0 : Math.round((crop[offset + 3] * matteAlpha) / 255);
    if (alpha > 0) {
      out[offset] = crop[offset];
      out[offset + 1] = crop[offset + 1];
      out[offset + 2] = crop[offset + 2];
      out[offset + 3] = alpha;
      visiblePixels += 1;
    }
    if (alpha < 255) transparentPixels += 1;
  }

  const png = await sharp(out, {
    raw: { width: bounds.width, height: bounds.height, channels: RGBA_CHANNELS },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    png: new Uint8Array(png),
    width: bounds.width,
    height: bounds.height,
    alphaStatus: visiblePixels > 0 && transparentPixels > 0 ? "transparent" : "opaque",
    visiblePixels,
    transparentPixels,
  };
}
