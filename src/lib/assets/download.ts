/** Secure MCP image download with exact HTTPS host allowlist and bounded streaming. */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type DownloadImageOptions = { allowedHosts: ReadonlySet<string>; maxBytes?: number; timeoutMs?: number };
export type DownloadImageError = { code: "DOWNLOAD_HOST_NOT_CONFIGURED" | "DOWNLOAD_HOST_NOT_ALLOWED" | "DOWNLOAD_NOT_HTTPS" | "DOWNLOAD_NO_CREDENTIALS" | "DOWNLOAD_IP_LITERAL" | "DOWNLOAD_REDIRECT_NOT_ALLOWED" | "DOWNLOAD_MIME_NOT_ALLOWED" | "DOWNLOAD_TOO_LARGE" | "DOWNLOAD_TIMEOUT" | "DOWNLOAD_FAILED"; message: string };
export class DownloadError extends Error {
  code: DownloadImageError["code"];
  constructor(code: DownloadImageError["code"], message: string) { super(message); this.name = "DownloadError"; this.code = code; }
}
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^\[?[0-9a-f:]+\]?$/i.test(hostname);
}
function validateUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== "https:") throw new DownloadError("DOWNLOAD_NOT_HTTPS", "Only HTTPS URLs are allowed");
  if (url.username || url.password) throw new DownloadError("DOWNLOAD_NO_CREDENTIALS", "URL must not contain credentials");
  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname)) throw new DownloadError("DOWNLOAD_IP_LITERAL", "IP literal hosts are not allowed");
  if (!allowedHosts.has(hostname) || (url.port && url.port !== "443")) throw new DownloadError("DOWNLOAD_HOST_NOT_ALLOWED", `Host "${hostname}" is not in the allowlist`);
}
export function parseAllowedHosts(envValue: string | undefined): ReadonlySet<string> {
  if (!envValue?.trim()) return new Set();
  return new Set(envValue.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}
function mimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
export async function downloadImageBytes(url: URL, options: DownloadImageOptions): Promise<Uint8Array> {
  const { allowedHosts, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (allowedHosts.size === 0) throw new DownloadError("DOWNLOAD_HOST_NOT_CONFIGURED", "MCP_IMAGE_DOWNLOAD_HOSTS is not configured; no hosts allowed");
  validateUrl(url, allowedHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    let response: Response;
    try {
      response = await fetch(url.href, { signal: controller.signal, redirect: "error", headers: { Accept: "image/png, image/jpeg, image/webp" } });
    } catch (error) {
      if (controller.signal.aborted) throw new DownloadError("DOWNLOAD_TIMEOUT", "Download exceeded deadline");
      throw new DownloadError("DOWNLOAD_REDIRECT_NOT_ALLOWED", error instanceof Error ? error.message : "Download request failed");
    }
    if (!response.ok) throw new DownloadError("DOWNLOAD_FAILED", `HTTP ${response.status}: ${response.statusText}`);
    const declared = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!ALLOWED_MIMES.has(declared)) throw new DownloadError("DOWNLOAD_MIME_NOT_ALLOWED", `Content-Type "${declared}" is not allowed`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) throw new DownloadError("DOWNLOAD_TOO_LARGE", `Content-Length ${length} exceeds limit ${maxBytes}`);
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadError("DOWNLOAD_FAILED", "No response body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new DownloadError("DOWNLOAD_TOO_LARGE", `Downloaded ${total} bytes exceeds limit ${maxBytes}`);
        chunks.push(value);
      }
    } finally { try { await reader.cancel(); } catch { /* best effort */ } }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    const actual = mimeFromBytes(result);
    if (!actual || actual !== declared) throw new DownloadError("DOWNLOAD_MIME_NOT_ALLOWED", `Content-Type "${declared}" does not match image bytes`);
    return result;
  } finally { clearTimeout(timer); }
}
