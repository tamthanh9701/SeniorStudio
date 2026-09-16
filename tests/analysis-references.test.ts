// @vitest-environment node
// Analysis sends every reference to a vision provider, but decoding is done
// locally first: a small file can describe an enormous image, and twenty of them
// decoded at once exhausted the instance.
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { downscaleReferences } from "../src/lib/style/analysis-references";

async function png(width: number, height: number, background = "#345678"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).png({ compressionLevel: 9 }).toBuffer();
}

describe("downscaleReferences", () => {
  it("fits a large reference into the working size", async () => {
    const [scaled] = await downscaleReferences([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", buffer: await png(2400, 1200), mimeType: "image/png" }]);
    const metadata = await sharp(scaled.buffer).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(640);
    expect(scaled.mimeType).toBe("image/jpeg");
  });

  it("keeps transparency as png", async () => {
    const buffer = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    const [scaled] = await downscaleReferences([{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", buffer, mimeType: "image/png" }]);
    expect(scaled.mimeType).toBe("image/png");
    expect((await sharp(scaled.buffer).metadata()).hasAlpha).toBe(true);
  });

  it("refuses a reference with more pixels than the decode budget", async () => {
    // 787 KB on disk, 260 megapixels decoded.
    const huge = await png(20000, 13000);
    expect(huge.byteLength).toBeLessThan(5 * 1024 * 1024);
    await expect(downscaleReferences([{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", buffer: huge, mimeType: "image/png" }]))
      .rejects.toMatchObject({ code: "REFERENCE_TOO_LARGE" });
  });
});
