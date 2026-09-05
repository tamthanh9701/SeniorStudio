// Normalized style-domain errors with canonical HTTP mapping.

export const STYLE_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  STYLE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  STYLE_NOT_READY: 400,
  STYLE_NOT_ACTIVE: 400,
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
