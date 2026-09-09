// Shared bounded-retry helper for style provider HTTP calls.
// The timeout is a single budget for the complete operation, including response
// body consumption and backoff between attempts.
export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
}

export class RetryableHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly body: string;

  constructor(status: number, body = "", retryAfterMs: number | null = null) {
    super(`HTTP ${status}`);
    this.name = "RetryableHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super("Provider operation timed out");
    this.name = "TimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Fetch's transport failures are unfortunately exposed as TypeError in browsers. */
function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "NetworkError") return true;
  if (!(error instanceof TypeError)) return false;
  return /^(?:fetch failed|failed to fetch|network error|networkerror|network request failed)\b/i.test(error.message.trim());
}

function isRetryableError(error: unknown): boolean {
  return (
    (error instanceof RetryableHttpError && retryableHttpStatus(error.status)) ||
    isRetryableNetworkError(error)
  );
}

function backoffMs(error: unknown, attempt: number, baseDelayMs: number, remaining: number): number {
  const retryAfterMs = error instanceof RetryableHttpError ? error.retryAfterMs : null;
  const requested = retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : Math.max(0, baseDelayMs) * 2 ** (attempt - 1);
  return Math.min(Math.max(0, requested), remaining);
}

/**
 * Runs a provider operation with bounded retry. The callback must consume and
 * parse its response while the supplied signal is alive. Retry decisions are
 * limited to retryable HTTP statuses (408, 429, 5xx) and known transport
 * failures. The timeout is one hard budget for callback, response body,
 * backoff, and every attempt; a late non-cooperative callback cannot win.
 */
export async function withProviderRetry<T>(
  options: RetryOptions,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  const attempts = Math.max(1, Math.floor(options.attempts));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = remainingMs(deadline);
    if (remaining <= 0) throw new ProviderTimeoutError();

    const signal = AbortSignal.timeout(remaining);
    const callback = Promise.resolve().then(() => fn(signal));
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        // AbortSignal.timeout normally already fired, but explicitly aborting
        // is not possible; the signal itself remains the callback's deadline.
        reject(new ProviderTimeoutError());
      }, remaining);
    });

    try {
      return await Promise.race([callback, timeout]);
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderTimeoutError || signal.aborted || remainingMs(deadline) <= 0) {
        throw new ProviderTimeoutError();
      }
      if (!isRetryableError(error) || attempt >= attempts) throw error;

      const budget = remainingMs(deadline);
      if (budget <= 0) throw new ProviderTimeoutError();
      await sleep(backoffMs(error, attempt, options.baseDelayMs, budget));
      if (remainingMs(deadline) <= 0) throw new ProviderTimeoutError();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}
