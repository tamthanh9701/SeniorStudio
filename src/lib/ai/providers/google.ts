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
  async submit(context) {
    const { job, apiKey } = context;
    if (job.operation !== "text_to_image" && job.operation !== "image_to_image") throw new ProviderError("INVALID_REQUEST", "Google does not support this operation");
    const ai = new GoogleGenAI({ apiKey });
    const model = job.model.replace(/^google\//, "");
    const source = context.inputImages?.find((img) => img.role === "source");
    const refs = (context.inputImages ?? []).filter((img) => img.role === "reference");
    const contents: Array<{ type: "text"; text: string } | { type: "image"; data: string; mime_type: string }> = [];
    if (job.input.prompt) contents.push({ type: "text", text: job.input.prompt });
    if (source) contents.push({ type: "image", data: Buffer.from(source.bytes).toString("base64"), mime_type: source.mimeType });
    for (const ref of refs) contents.push({ type: "image", data: Buffer.from(ref.bytes).toString("base64"), mime_type: ref.mimeType });
    const interactions = [];
    for (let index = 0; index < job.input.count; index += 1) {
      const body = {
        model,
        input: contents.length > 0 ? contents : job.input.prompt,
        store: false,
        labels: { output_index: String(index) },
        response_format: { type: "image" as const, mime_type: "image/jpeg", aspect_ratio: aspectRatio(job.input.size), image_size: "1K" },
      };
      const interaction = context.signal
        ? await ai.interactions.create(body, { signal: context.signal, timeout: 150_000, maxRetries: 0 })
        : await ai.interactions.create(body);
      interactions.push(interaction);
    }
    const images = interactions.map((interaction) => {
      const output = interaction.output_image;
      if (!output?.data) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "Google returned no image data");
      return { kind: "bytes" as const, bytes: new Uint8Array(Buffer.from(output.data, "base64")), contentType: output.mime_type ?? "image/png" };
    });
    return { state: "completed", images, requestId: interactions[0]?.id ?? null, metadata: { interaction_ids: interactions.map((interaction) => interaction.id) } };
  },
  async poll() { throw new ProviderError("INVALID_PROVIDER_STATE", "Google image generation completes during submission"); },
  async cancel() { throw new ProviderError("JOB_NOT_CANCELABLE", "Google image requests cannot be canceled after submission"); },
};
