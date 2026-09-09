import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import type { ImageProvider } from "./types";
import { ProviderError } from "./types";

function modelWithoutPrefix(model: string) {
  return model.replace(/^openai\//, "");
}

function fileNameForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "image.jpg";
  if (mimeType === "image/webp") return "image.webp";
  return "source.png";
}

export const openAiProvider: ImageProvider = {
  async submit(context) {
    const { job, apiKey } = context;
    const openai = new OpenAI({ apiKey, maxRetries: 0, timeout: 150_000 });
    const model = modelWithoutPrefix(job.model);
    const options = context.signal ? { signal: context.signal } : undefined;

    if (job.operation === "text_to_image") {
      const request = { model, prompt: job.input.prompt, n: job.input.count, size: job.input.size, quality: job.input.quality };
      const response = options ? await openai.images.generate(request, options) : await openai.images.generate(request);
      const responseData = response.data ?? [];
      const images = responseData.map((image) => {
        if (!image.b64_json) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "OpenAI returned no image data");
        return { kind: "bytes" as const, bytes: new Uint8Array(Buffer.from(image.b64_json, "base64")), contentType: "image/png" };
      });
      return { state: "completed", images, requestId: null, metadata: { revised_prompt: responseData[0]?.revised_prompt ?? undefined } };
    }

    if (job.operation === "image_to_image") {
      const source = context.inputImages?.find((img) => img.role === "source");
      if (!source) throw new ProviderError("INVALID_REQUEST", "image_to_image requires a source image in context");
      const refs = (context.inputImages ?? []).filter((img) => img.role === "reference");
      const imageArray: File[] = [await toFile(source.bytes, fileNameForMime(source.mimeType), { type: source.mimeType })];
      for (const ref of refs) imageArray.push(await toFile(ref.bytes, fileNameForMime(ref.mimeType), { type: ref.mimeType }));
      const response = await openai.images.edit({
        model,
        prompt: job.input.prompt,
        n: job.input.count,
        size: job.input.size,
        quality: job.input.quality,
        image: imageArray,
      }, options);
      const responseData = response.data ?? [];
      const images = responseData.map((image) => {
        if (!image.b64_json) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "OpenAI returned no image data");
        return { kind: "bytes" as const, bytes: new Uint8Array(Buffer.from(image.b64_json, "base64")), contentType: "image/png" };
      });
      return { state: "completed", images, requestId: null, metadata: { revised_prompt: responseData[0]?.revised_prompt ?? undefined } };
    }

    if (job.operation !== "inpaint") throw new ProviderError("INVALID_REQUEST", `Unsupported operation: ${job.operation}`);
    const source = context.inputImages?.find((img) => img.role === "source");
    if (!source) throw new ProviderError("INVALID_REQUEST", "Inpaint requires source image in context inputImages");
    if (!context.maskBytes) throw new ProviderError("INVALID_REQUEST", "Inpaint requires mask bytes in context");
    if (source.bytes.byteLength > 50 * 1024 * 1024 || context.maskBytes.byteLength > 50 * 1024 * 1024) throw new ProviderError("FILE_TOO_LARGE", "Image and mask must each be at most 50 MiB");
    const [sourceMetadata, maskMetadata] = await Promise.all([sharp(source.bytes).metadata(), sharp(context.maskBytes).metadata()]);
    if (!sourceMetadata.width || !sourceMetadata.height || sourceMetadata.width !== maskMetadata.width || sourceMetadata.height !== maskMetadata.height) throw new ProviderError("VERSION_CONFLICT", "Image and mask dimensions must match");
    const rgbaMask = await sharp(context.maskBytes).ensureAlpha().png().toBuffer();
    const response = await openai.images.edit({
      model,
      prompt: job.input.prompt,
      n: 1,
      size: job.input.size,
      quality: job.input.quality,
      image: await toFile(source.bytes, fileNameForMime(source.mimeType), { type: source.mimeType }),
      mask: await toFile(rgbaMask, "mask.png", { type: "image/png" }),
    }, options);
    const responseData = response.data ?? [];
    const images = responseData.map((image) => {
      if (!image.b64_json) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "OpenAI returned no image data");
      return { kind: "bytes" as const, bytes: new Uint8Array(Buffer.from(image.b64_json, "base64")), contentType: "image/png" };
    });
    return { state: "completed", images, requestId: null, metadata: { revised_prompt: responseData[0]?.revised_prompt ?? undefined } };
  },
  async poll() { throw new ProviderError("INVALID_PROVIDER_STATE", "OpenAI Image API completes during submission"); },
  async cancel() { throw new ProviderError("JOB_NOT_CANCELABLE", "OpenAI Image API requests cannot be canceled after submission"); },
};
