import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { getEnv } from "@/env";
import { STORAGE_BUCKET } from "@/db/schema";
import type { ImageProvider, ProviderContext } from "./types";
import { ProviderError } from "./types";

async function downloadParent(context: ProviderContext) {
  if (!context.job.parent_version_id) throw new ProviderError("INVALID_REQUEST", "Inpaint requires a parent version");
  const { data: version, error } = await context.client.from("asset_versions").select("storage_path").eq("id", context.job.parent_version_id).single();
  if (error || !version) throw new ProviderError("NOT_FOUND", "Parent version was not found");
  const { data, error: downloadError } = await context.client.storage.from(STORAGE_BUCKET).download(version.storage_path);
  if (downloadError || !data) throw new ProviderError("FILE_UNAVAILABLE", "Parent image could not be downloaded");
  return new Uint8Array(await data.arrayBuffer());
}

async function downloadMask(context: ProviderContext) {
  const maskPath = context.job.input.mask_storage_path;
  if (!maskPath) throw new ProviderError("INVALID_REQUEST", "Inpaint requires a mask");
  const { data, error } = await context.client.storage.from(STORAGE_BUCKET).download(maskPath);
  if (error || !data) throw new ProviderError("FILE_UNAVAILABLE", "Mask could not be downloaded");
  return new Uint8Array(await data.arrayBuffer());
}

export const openAiProvider: ImageProvider = {
  async submit(context) {
    const { job, apiKey } = context;
    const openai = new OpenAI({ apiKey });
    const model = getEnv().OPENAI_IMAGE_MODEL;
    let response;
    if (job.operation === "text_to_image") {
      response = await openai.images.generate({
        model, prompt: job.input.prompt, n: job.input.count, size: job.input.size,
        quality: job.input.quality, response_format: "b64_json",
      });
    } else {
      const [sourceBytes, canonicalMask] = await Promise.all([downloadParent(context), downloadMask(context)]);
      if (sourceBytes.byteLength > 50 * 1024 * 1024 || canonicalMask.byteLength > 50 * 1024 * 1024) {
        throw new ProviderError("FILE_TOO_LARGE", "Image and mask must each be at most 50 MiB");
      }
      const [sourceMetadata, maskMetadata] = await Promise.all([sharp(sourceBytes).metadata(), sharp(canonicalMask).metadata()]);
      if (!sourceMetadata.width || !sourceMetadata.height || sourceMetadata.width !== maskMetadata.width || sourceMetadata.height !== maskMetadata.height) {
        throw new ProviderError("VERSION_CONFLICT", "Image and mask dimensions must match");
      }
      const rgbaMask = await sharp(canonicalMask).ensureAlpha().png().toBuffer();
      response = await openai.images.edit({
        model, prompt: job.input.prompt, n: 1, quality: job.input.quality,
        image: await toFile(sourceBytes, "source.png", { type: "image/png" }),
        mask: await toFile(rgbaMask, "mask.png", { type: "image/png" }),
        response_format: "b64_json",
      });
    }
    const responseData = response.data ?? [];
    const images = responseData.map((image) => {
      if (!image.b64_json) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "OpenAI returned no image data");
      return { kind: "bytes" as const, bytes: new Uint8Array(Buffer.from(image.b64_json, "base64")), contentType: "image/png" };
    });
    return {
      state: "completed" as const, images, requestId: null,
      metadata: { revised_prompt: responseData[0]?.revised_prompt ?? undefined },
    };
  },
  async poll() {
    throw new ProviderError("INVALID_PROVIDER_STATE", "OpenAI Image API completes during submission");
  },
  async cancel() {
    throw new ProviderError("JOB_NOT_CANCELABLE", "OpenAI Image API requests cannot be canceled after submission");
  },
};
