// Shared bounded-retry helper for style provider HTTP calls.
// Retries only network errors and HTTP 408/429/5xx; honors Retry-After;
// never retries 400/401/403. Provider error text is preserved (adapters must
// never log or embed the API key in error messages).
export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Runs `fn` with bounded retry. Throws the last network error or an
 * Error("HTTP <status>") shaped failure for the caller to classify.
 */
export async function withProviderRetry(
  options: RetryOptions,
  fn: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fn(controller.signal);
      if (response.ok || !isRetryableStatus(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (attempt === options.attempts) return response;
      const delay = Math.max(retryAfterMs(response) ?? options.baseDelayMs * 2 ** (attempt - 1), 1000);
      await sleep(delay + Math.floor(Math.random() * 250));
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts) throw error;
      await sleep(options.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}
