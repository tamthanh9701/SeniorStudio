// Normalized style-domain errors with canonical HTTP mapping.

export const STYLE_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  STYLE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  // A missing or foreign reference is a 404 on every path; without this entry the
  // StyleError branch answered 400 for the same code the generic branch mapped to 404.
  REFERENCE_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  STYLE_NOT_READY: 409,
  STYLE_NOT_ACTIVE: 409,
  STYLE_VERSION_CONFLICT: 409,
  STYLE_ANALYSIS_STALE: 409,
  STYLE_SOURCE_SNAPSHOT_REQUIRED: 409,
  STYLE_DEFINITION_INVALID: 409,
  STYLE_CONFLICT: 400,
  PROMPT_TOO_LONG: 400,
  NO_REFERENCES: 400,
  TOO_MANY_REFERENCES: 400,
  REFERENCE_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE_TYPE: 415,
  FILE_UNAVAILABLE: 500,
  STYLE_ANALYSIS_NOT_CONFIGURED: 503,
  STYLE_ANALYSIS_RATE_LIMITED: 429,
  STYLE_ANALYSIS_FAILED: 502,
  STYLE_ANALYSIS_UNPARSED: 502,
};

export function styleErrorStatus(code: string): number {
  return STYLE_ERROR_STATUS[code] ?? 400;
}

export class StyleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StyleError";
    this.code = code;
    this.status = styleErrorStatus(code);
  }
}
