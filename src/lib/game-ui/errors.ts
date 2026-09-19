// Normalized Game UI errors with canonical HTTP mapping, mirroring the style
// domain's error surface so routes answer with the same envelope.

export const GAME_UI_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  SCREEN_NOT_FOUND: 404,
  RENDER_NOT_FOUND: 404,
  ELEMENT_NOT_FOUND: 404,
  OUTPUT_NOT_FOUND: 404,
  INPUT_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  TOO_MANY_ELEMENTS: 400,
  PROMPT_TOO_LONG: 400,
  TOO_MANY_REFERENCES: 400,
  DOCUMENT_TOO_LARGE: 413,
  REFERENCE_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE_TYPE: 415,
  GAME_UI_NOT_READY: 409,
  STYLE_NOT_READY: 409,
  STYLE_VERSION_CONFLICT: 409,
  SCREEN_VERSION_CONFLICT: 409,
  ANALYSIS_STALE: 409,
  PLAN_CONSENT_MISMATCH: 409,
  ASSET_PACK_NOT_READY: 409,
  SOURCE_IN_USE: 409,
  CONFLICT: 409,
  BACKGROUND_NOT_REMOVED: 422,
  TRANSPARENCY_REQUIRED: 422,
  GAME_UI_ANALYSIS_INVALID: 502,
  GAME_UI_ANALYSIS_FAILED: 502,
  FILE_UNAVAILABLE: 500,
  GAME_UI_ANALYSIS_NOT_CONFIGURED: 503,
};

export function gameUiErrorStatus(code: string): number {
  return GAME_UI_ERROR_STATUS[code] ?? 400;
}

export class GameUiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GameUiError";
    this.code = code;
    this.status = gameUiErrorStatus(code);
  }
}

/** Reuse the game UI status mapping for errors raised by shared style helpers. */
export function isGameUiError(error: unknown): error is GameUiError {
  return error instanceof GameUiError;
}
