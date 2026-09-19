// @vitest-environment node
// Exact extraction is deterministic pixel math, so these assertions decode the
// produced PNG and compare channel values against the synthetic source and
// matte instead of trusting file sizes or prompt wording.
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { GameUiError } from "@/lib/game-ui/errors";
import { extractElement } from "@/lib/game-ui/extraction";

const SOURCE_WIDTH = 8;
const SOURCE_HEIGHT = 8;
const BOX = { x: 2, y: 3, width: 3, height: 2 };
// Source pixel (3,3) is the alpha-multiplication case: 128 * 128 / 255 -> 64.
const HALF_ALPHA_PIXEL = 3 * SOURCE_WIDTH + 3;

/** Distinct, losslessly encoded colours so any channel swap is visible. */
function sourceRgba(): number[] {
  const rgba: number[] = [];
  for (let pixel = 0; pixel < SOURCE_WIDTH * SOURCE_HEIGHT; pixel += 1) {
    const x = pixel % SOURCE_WIDTH;
    const y = Math.floor(pixel / SOURCE_WIDTH);
    rgba.push(8 + x * 17, 12 + y * 23, (5 + pixel * 7) % 240, pixel === HALF_ALPHA_PIXEL ? 128 : 255);
  }
  return rgba;
}

function sourcePixelAt(x: number, y: number): [number, number, number, number] {
  const pixel = y * SOURCE_WIDTH + x;
  return [8 + x * 17, 12 + y * 23, (5 + pixel * 7) % 240, pixel === HALF_ALPHA_PIXEL ? 128 : 255];
}

async function png(width: number, height: number, rgba: number[]): Promise<Uint8Array> {
  const buffer = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer();
  return new Uint8Array(buffer);
}

function matteRgba(alphas: number[]): number[] {
  const rgba: number[] = [];
  for (const alpha of alphas) rgba.push(0, 0, 0, alpha);
  return rgba;
}

async function decodeRgba(bytes: Uint8Array): Promise<{ pixels: number[]; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(bytes).ensureAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { pixels: [...data], width: info.width, height: info.height, channels: info.channels };
}

async function captureError(run: () => Promise<unknown>): Promise<GameUiError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GameUiError);
    return error as GameUiError;
  }
  throw new Error("expected extractElement to reject");
}

describe("extractElement", () => {
  it("crops the box, keeps source RGB and multiplies alpha channel-wise", async () => {
    const matteAlphas = [255, 128, 0, 64, 255, 200];
    const result = await extractElement({
      sourceBytes: await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba()),
      matteBytes: await png(BOX.width, BOX.height, matteRgba(matteAlphas)),
      bounds: BOX,
    });

    expect(result.width).toBe(BOX.width);
    expect(result.height).toBe(BOX.height);
    expect(result.alphaStatus).toBe("transparent");
    // Visible = alpha > 0 (five pixels); transparent = alpha < 255 (64, 0, 64, 200).
    expect(result.visiblePixels).toBe(5);
    expect(result.transparentPixels).toBe(4);

    const decoded = await decodeRgba(result.png);
    expect(decoded.width).toBe(BOX.width);
    expect(decoded.height).toBe(BOX.height);
    expect(decoded.channels).toBe(4);

    matteAlphas.forEach((matteAlpha, index) => {
      const px = index % BOX.width;
      const py = Math.floor(index / BOX.width);
      const [r, g, b, sourceAlpha] = sourcePixelAt(BOX.x + px, BOX.y + py);
      const offset = index * 4;
      if (matteAlpha === 0) {
        expect(decoded.pixels.slice(offset, offset + 4)).toEqual([0, 0, 0, 0]);
        return;
      }
      const expectedAlpha = Math.round((sourceAlpha * matteAlpha) / 255);
      expect(decoded.pixels.slice(offset, offset + 4)).toEqual([r, g, b, expectedAlpha]);
    });

    // The fractional case explicitly: 128 * 128 / 255 rounds to 64.
    expect(decoded.pixels.slice(4, 8)).toEqual([...sourcePixelAt(3, 3).slice(0, 3), 64]);
  });

  it("emits exactly 0,0,0,0 where the matte removes opaque source pixels", async () => {
    const result = await extractElement({
      sourceBytes: await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba()),
      matteBytes: await png(2, 1, matteRgba([255, 0])),
      bounds: { x: 0, y: 0, width: 2, height: 1 },
    });

    const decoded = await decodeRgba(result.png);
    const [r, g, b] = sourcePixelAt(1, 0);
    expect([r, g, b]).not.toEqual([0, 0, 0]);
    expect(decoded.pixels.slice(4, 8)).toEqual([0, 0, 0, 0]);
    expect(decoded.pixels.slice(0, 4)).toEqual([...sourcePixelAt(0, 0)]);
    expect(result.alphaStatus).toBe("transparent");
    expect(result.transparentPixels).toBe(1);
  });

  it("reports an opaque result when the matte keeps every pixel", async () => {
    const result = await extractElement({
      sourceBytes: await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba().map((value, index) => (index % 4 === 3 ? 255 : value))),
      matteBytes: await png(BOX.width, BOX.height, matteRgba(new Array(BOX.width * BOX.height).fill(255))),
      bounds: BOX,
    });

    expect(result.alphaStatus).toBe("opaque");
    expect(result.transparentPixels).toBe(0);
    expect(result.visiblePixels).toBe(BOX.width * BOX.height);
    const decoded = await decodeRgba(result.png);
    for (let index = 0; index < BOX.width * BOX.height; index += 1) {
      expect(decoded.pixels[index * 4 + 3]).toBe(255);
    }
  });

  it("rejects a matte sized differently from the element box", async () => {
    const sourceBytes = await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba());
    const matteBytes = await png(2, 2, matteRgba([255, 255, 255, 255]));
    const error = await captureError(() => extractElement({ sourceBytes, matteBytes, bounds: BOX }));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.status).toBe(400);
  });

  it("rejects a fully transparent matte instead of emitting an empty asset", async () => {
    const sourceBytes = await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba());
    const matteBytes = await png(BOX.width, BOX.height, matteRgba([0, 0, 0, 0, 0, 0]));
    const error = await captureError(() => extractElement({ sourceBytes, matteBytes, bounds: BOX }));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.status).toBe(400);
  });

  it("rejects a matte that is not a PNG and a PNG without an alpha channel", async () => {
    const sourceBytes = await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba());
    const jpegMatte = new Uint8Array(
      await sharp(Buffer.from(matteRgba([255, 255, 255, 255, 255, 255])), {
        raw: { width: BOX.width, height: BOX.height, channels: 4 },
      })
        .jpeg()
        .toBuffer(),
    );
    const jpegError = await captureError(() => extractElement({ sourceBytes, matteBytes: jpegMatte, bounds: BOX }));
    expect(jpegError.code).toBe("UNSUPPORTED_IMAGE_TYPE");
    expect(jpegError.status).toBe(415);

    const opaquePng = new Uint8Array(
      await sharp(Buffer.from(new Array(BOX.width * BOX.height * 3).fill(255)), {
        raw: { width: BOX.width, height: BOX.height, channels: 3 },
      })
        .png()
        .toBuffer(),
    );
    const alphaError = await captureError(() => extractElement({ sourceBytes, matteBytes: opaquePng, bounds: BOX }));
    expect(alphaError.code).toBe("UNSUPPORTED_IMAGE_TYPE");

    // An empty or truncated upload must not escape as a raw sharp error.
    const emptyError = await captureError(() => extractElement({ sourceBytes, matteBytes: new Uint8Array(0), bounds: BOX }));
    expect(emptyError.code).toBe("UNSUPPORTED_IMAGE_TYPE");
    const garbageError = await captureError(() =>
      extractElement({ sourceBytes, matteBytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), bounds: BOX }),
    );
    expect(garbageError.code).toBe("UNSUPPORTED_IMAGE_TYPE");
  });

  it("rejects bounds outside the source image, non-integer bounds and empty boxes", async () => {
    const sourceBytes = await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba());
    const matteBytes = await png(4, 4, matteRgba(new Array(16).fill(255)));

    const outside = await captureError(() => extractElement({ sourceBytes, matteBytes, bounds: { x: 6, y: 0, width: 3, height: 2 } }));
    expect(outside.code).toBe("INVALID_REQUEST");

    const negative = await captureError(() => extractElement({ sourceBytes, matteBytes, bounds: { x: -1, y: 0, width: 3, height: 2 } }));
    expect(negative.code).toBe("INVALID_REQUEST");

    const fractional = await captureError(() => extractElement({ sourceBytes, matteBytes, bounds: { x: 1.5, y: 0, width: 3, height: 2 } }));
    expect(fractional.code).toBe("INVALID_REQUEST");

    const empty = await captureError(() => extractElement({ sourceBytes, matteBytes, bounds: { x: 0, y: 0, width: 0, height: 2 } }));
    expect(empty.code).toBe("INVALID_REQUEST");
  });

  it("leaves the caller's source and matte buffers untouched", async () => {
    const sourceBytes = await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba());
    const matteBytes = await png(BOX.width, BOX.height, matteRgba([255, 128, 0, 64, 255, 200]));
    const sourceBefore = Uint8Array.from(sourceBytes);
    const matteBefore = Uint8Array.from(matteBytes);

    await extractElement({ sourceBytes, matteBytes, bounds: BOX });

    expect(sourceBytes.byteLength).toBe(sourceBefore.byteLength);
    expect(Buffer.compare(Buffer.from(sourceBytes), Buffer.from(sourceBefore))).toBe(0);
    expect(Buffer.compare(Buffer.from(matteBytes), Buffer.from(matteBefore))).toBe(0);
  });

  it("extracts from a source without an alpha channel (JPEG screen)", async () => {
    const jpegSource = new Uint8Array(
      await sharp(Buffer.from([200, 40, 40, 255, 40, 200, 40, 255, 40, 40, 200, 255, 240, 240, 40, 255]), {
        raw: { width: 2, height: 2, channels: 4 },
      })
        .jpeg({ quality: 100 })
        .toBuffer(),
    );
    const matteBytes = await png(2, 1, matteRgba([255, 0]));

    const result = await extractElement({ sourceBytes: jpegSource, matteBytes, bounds: { x: 0, y: 1, width: 2, height: 1 } });

    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect(result.alphaStatus).toBe("transparent");
    const decoded = await decodeRgba(result.png);
    expect(decoded.channels).toBe(4);
    // The JPEG itself carries no alpha, so the kept pixel must be fully opaque
    // and must still hold decoded source colour rather than a zeroed pixel.
    expect(decoded.pixels[3]).toBe(255);
    expect(decoded.pixels.slice(0, 3).some((channel) => channel > 0)).toBe(true);
    expect(decoded.pixels.slice(4, 8)).toEqual([0, 0, 0, 0]);
  });

  it("applies EXIF orientation before validating and cropping bounds", async () => {
    // Stored 8x4 with orientation 6; the decoded screen is 4x8, and the box is
    // expressed in those oriented pixels.
    const stored: number[] = [];
    for (let pixel = 0; pixel < 8 * 4; pixel += 1) stored.push((pixel * 13) % 240, (pixel * 29) % 240, (pixel * 47) % 240, 255);
    const rotated = new Uint8Array(
      await sharp(Buffer.from(stored), { raw: { width: 8, height: 4, channels: 4 } })
        .jpeg({ quality: 100 })
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    const matteBytes = await png(4, 8, matteRgba(new Array(32).fill(255)));

    const result = await extractElement({ sourceBytes: rotated, matteBytes, bounds: { x: 0, y: 0, width: 4, height: 8 } });
    expect(result.width).toBe(4);
    expect(result.height).toBe(8);

    // The stored (unrotated) shape would be 8x4, so this box is only out of
    // range once orientation has been applied.
    const error = await captureError(() =>
      extractElement({ sourceBytes: rotated, matteBytes, bounds: { x: 0, y: 0, width: 8, height: 4 } }),
    );
    expect(error.code).toBe("INVALID_REQUEST");
  });

  it("produces identical bytes for identical inputs", async () => {
    const sourceBytes = await png(SOURCE_WIDTH, SOURCE_HEIGHT, sourceRgba());
    const matteBytes = await png(BOX.width, BOX.height, matteRgba([255, 128, 0, 64, 255, 200]));

    const first = await extractElement({ sourceBytes, matteBytes, bounds: BOX });
    const second = await extractElement({ sourceBytes, matteBytes, bounds: BOX });

    expect(Buffer.compare(Buffer.from(first.png), Buffer.from(second.png))).toBe(0);
  });
});
