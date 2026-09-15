import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { compositeInpaintResult } from "../src/lib/assets/inpaint-composite";

/**
 * The outside-mask invariant is the reason an edit cannot silently repaint an
 * image, so these assertions compare decoded pixels rather than file bytes.
 */
async function encode(width: number, height: number, rgba: number[]): Promise<Uint8Array> {
  const buffer = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer();
  return new Uint8Array(buffer);
}

async function maskOf(width: number, height: number, alphas: number[]): Promise<Uint8Array> {
  const rgba: number[] = [];
  for (const alpha of alphas) rgba.push(255, 255, 255, alpha);
  return encode(width, height, rgba);
}

async function decoded(bytes: Uint8Array): Promise<number[]> {
  const { data } = await sharp(bytes).ensureAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return [...data];
}

describe("compositeInpaintResult", () => {
  const source = () => encode(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]);
  const generated = () => encode(2, 1, [200, 100, 0, 255, 0, 100, 200, 255]);

  it("keeps protected pixels byte-identical to the source", async () => {
    const out = await compositeInpaintResult(await source(), await generated(), await maskOf(2, 1, [255, 0]));
    const pixels = await decoded(out);
    expect(pixels.slice(0, 4)).toEqual([10, 20, 30, 255]);
    expect(pixels.slice(4)).toEqual([0, 100, 200, 255]);
  });

  it("blends fractional alpha edges by the edit share", async () => {
    const out = await compositeInpaintResult(await source(), await generated(), await maskOf(2, 1, [128, 255]));
    const pixels = await decoded(out);
    const edit = (255 - 128) / 255;
    const keep = 128 / 255;
    expect(pixels[0]).toBe(Math.round(200 * edit + 10 * keep));
    expect(pixels[1]).toBe(Math.round(100 * edit + 20 * keep));
    expect(pixels[2]).toBe(Math.round(0 * edit + 30 * keep));
    expect(pixels.slice(4)).toEqual([40, 50, 60, 255]);
  });

  it("rejects a generated image whose dimensions differ from the source", async () => {
    await expect(compositeInpaintResult(await source(), await encode(1, 1, [0, 0, 0, 255]), await maskOf(2, 1, [0, 0])))
      .rejects.toThrow(/INPAINT_DIMENSION_MISMATCH/);
  });

  it("rejects a mask whose dimensions differ from the source", async () => {
    await expect(compositeInpaintResult(await source(), await generated(), await maskOf(1, 1, [0])))
      .rejects.toThrow(/INPAINT_DIMENSION_MISMATCH/);
  });

  it("rejects a mask that protects every pixel", async () => {
    await expect(compositeInpaintResult(await source(), await generated(), await maskOf(2, 1, [255, 255])))
      .rejects.toThrow(/INPAINT_EMPTY_MASK/);
  });
});
