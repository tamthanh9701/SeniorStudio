export type TransportRequest = { url: string; method: string; body: Uint8Array; signal?: AbortSignal };
export type TransportResponse = { status: number; headers?: Record<string, string>; body: Uint8Array };
let handler: ((request: TransportRequest) => Promise<TransportResponse>) | undefined;
export function installProviderTransport(next: (request: TransportRequest) => Promise<TransportResponse>) { handler = next; }
export function resetProviderTransport() { handler = undefined; }
export async function providerFetch(request: TransportRequest): Promise<TransportResponse> {
  if (!handler) throw new Error("provider transport was not installed");
  return handler(request);
}
