// One place that turns a thrown failure into an HTTP status and error code.
//
// The same failure used to be mapped by hand in each route, with slightly
// different lists: REFERENCE_NOT_FOUND answered 400 on one path and 404 on
// another, and a route that read `error instanceof Error` mapped every PostgREST
// refusal (which is a plain object) to the fallback.
import { StyleError } from "@/lib/style/errors";

export type ApiError = { status: number; code: string; message: string };

/** Message of anything thrown, including PostgREST's plain error objects. */
export function errorMessage(error: unknown, fallback = "INVALID_REQUEST"): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return fallback;
}

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  STYLE_NOT_FOUND: 404,
  SOURCE_NOT_FOUND: 404,
  REFERENCE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  STYLE_NOT_READY: 409,
  STYLE_NOT_ACTIVE: 409,
  STYLE_ANALYSIS_STALE: 409,
  STYLE_SOURCE_SNAPSHOT_REQUIRED: 409,
  STYLE_DEFINITION_INVALID: 409,
  STYLE_CONFLICT: 409,
  STYLE_VERSION_CONFLICT: 409,
  REFERENCE_CONTENT_CHANGED: 409,
  PLAN_CONSENT_MISMATCH: 409,
  REFERENCE_LIMIT_EXCEEDED: 400,
  REFERENCE_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE_TYPE: 415,
  INVALID_MODEL: 400,
  UNSUPPORTED_SETTINGS: 400,
  quota_exceeded: 429,
  QUOTA_UNAVAILABLE: 503,
  PROVIDER_NOT_CONFIGURED: 503,
};

/** Codes that are reported under a different API code than the one thrown. */
const CODE_ALIASES: Record<string, string> = { PROMPT_REQUIRED: "INVALID_REQUEST" };

/** Longest match wins, so STYLE_NOT_FOUND is not reported as NOT_FOUND. */
const KNOWN_CODES = Object.keys(STATUS_BY_CODE).sort((a, b) => b.length - a.length);

/**
 * @param fallbackCode code used when nothing recognisable is found in the message
 * @param fallbackStatus status used alongside it (the plan route answers 400)
 */
export function apiErrorFrom(error: unknown, options: { fallbackCode?: string; fallbackStatus?: number } = {}): ApiError {
  // Style-domain failures carry their own code and status.
  if (error instanceof StyleError) return { status: error.status, code: error.code, message: error.message };

  const message = errorMessage(error, options.fallbackCode ?? "INVALID_REQUEST");
  const matched = KNOWN_CODES.find((code) => message.includes(code));
  if (!matched) return { status: options.fallbackStatus ?? 400, code: options.fallbackCode ?? "INVALID_REQUEST", message };
  return { status: STATUS_BY_CODE[matched], code: CODE_ALIASES[matched] ?? matched, message };
}
