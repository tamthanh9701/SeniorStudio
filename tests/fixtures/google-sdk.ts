import { providerFetch } from "./provider-transport";
export class GoogleGenAI {
  interactions = { create: async (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    const response = await providerFetch({ url: "https://generativelanguage.googleapis.com/v1beta/interactions", method: "POST", body: new TextEncoder().encode(JSON.stringify(request)), signal: options?.signal });
    if (response.status >= 400) throw new Error(`fixture Google HTTP ${response.status}`);
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  } };
  constructor(options: { apiKey: string }) { if (!options.apiKey) throw new Error("fixture Google key required"); }
}
