import { providerFetch } from "./provider-transport";
export class OpenAI {
  images = { generate: async (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    const response = await providerFetch({ url: "https://api.openai.com/v1/images/generations", method: "POST", body: new TextEncoder().encode(JSON.stringify(request)), signal: options?.signal });
    if (response.status >= 400) throw new Error(`fixture OpenAI HTTP ${response.status}`);
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  } };
  constructor(options: { apiKey: string }) { if (!options.apiKey) throw new Error("fixture OpenAI key required"); }
}
