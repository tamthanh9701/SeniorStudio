import { GoogleGenAI } from "@google/genai";
import type { ImageProvider } from "./types";
import { ProviderError } from "./types";

function aspectRatio(size: string) {
  if (size === "1024x1024") return "1:1";
  if (size === "1536x1024") return "3:2";
  if (size === "1024x1536") return "2:3";
  throw new ProviderError("INVALID_REQUEST", "Unsupported Google image size");
}

export const googleProvider: ImageProvider = {
  async submit({ job, apiKey }) {
    if (job.operation !== "text_to_image") {
      throw new ProviderError("INVALID_MODEL", "The selected Google model does not support masked inpaint in SeniorStudio");
    }
    const ai = new GoogleGenAI({ apiKey });
    const interactions = await Promise.all(Array.from({ length: job.input.count }, () => ai.interactions.create({
      model: job.model.replace(/^google\//, ""),
      input: job.input.prompt,
      store: false,
      response_format: {
        type: "image",
        mime_type: "image/jpeg",
        aspect_ratio: aspectRatio(job.input.size),
        image_size: "1K",
      },
    })));
    const images = interactions.map((interaction) => {
      const output = interaction.output_image;
      if (!output?.data) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "Google returned no image data");
      return { kind: "bytes" as const, bytes: new Uint8Array(Buffer.from(output.data, "base64")), contentType: output.mime_type ?? "image/png" };
    });
    return {
      state: "completed",
      images,
      requestId: interactions[0]?.id ?? null,
      metadata: { interaction_ids: interactions.map((interaction) => interaction.id) },
    };
  },
  async poll() {
    throw new ProviderError("INVALID_PROVIDER_STATE", "Google image generation completes during submission");
  },
  async cancel() {
    throw new ProviderError("JOB_NOT_CANCELABLE", "Google image requests cannot be canceled after submission");
  },
};
