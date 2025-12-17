/**
 * Standardized error codes for IllegalActionError and API errors
 *
 * These codes are used consistently across:
 * - Engine (IllegalActionError)
 * - API (HTTP error responses)
 * - Client SDK (error handling)
 *
 * Using a const object pattern for:
 * - Type safety at compile time
 * - Autocomplete in IDEs
 * - Documentation of all possible error codes
 * - Easy refactoring
 */
export const ErrorCodes = {
  // Generic errors
  INVALID_ACTION: "INVALID_ACTION",

  // Player errors
  PLAYER_NOT_FOUND: "PLAYER_NOT_FOUND",
  PLAYER_NOT_ACTIVE: "PLAYER_NOT_ACTIVE",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  NO_CHIPS: "NO_CHIPS",
  NOT_SEATED: "NOT_SEATED",

  // Betting action errors
  CANNOT_CHECK: "CANNOT_CHECK",
  NOTHING_TO_CALL: "NOTHING_TO_CALL",
  CANNOT_BET: "CANNOT_BET",
  BET_TOO_SMALL: "BET_TOO_SMALL",
  CANNOT_RAISE: "CANNOT_RAISE",
  CANNOT_RERAISE: "CANNOT_RERAISE",
  RAISE_TOO_SMALL: "RAISE_TOO_SMALL",

  // Deal errors
  CANNOT_DEAL: "CANNOT_DEAL",
  NOT_ENOUGH_PLAYERS: "NOT_ENOUGH_PLAYERS",

  // Seat errors
  INVALID_SEAT: "INVALID_SEAT",
  SEAT_OCCUPIED: "SEAT_OCCUPIED",
  INVALID_STACK: "INVALID_STACK",

  // Validation errors
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",

  // Financial errors
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  INVALID_BUY_IN: "INVALID_BUY_IN",

  // Authentication/Authorization errors
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",

  // Resource errors
  NOT_FOUND: "NOT_FOUND",
  TABLE_NOT_FOUND: "TABLE_NOT_FOUND",

  // Rate limiting
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // Server errors
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

/**
 * Type representing all valid error codes
 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Helper to check if an error message contains a specific error code
 */
export function hasErrorCode(error: Error, code: ErrorCode): boolean {
  return error.message.includes(code);
}

/**
 * Standard error response structure for API endpoints
 */
export interface ErrorResponse {
  readonly error: ErrorCode;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly statusCode?: number;
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  code: ErrorCode,
  message: string,
  context?: Record<string, unknown>,
  statusCode?: number
): ErrorResponse {
  return {
    error: code,
    message,
    ...(context && { context }),
    ...(statusCode && { statusCode }),
  };
}

/**
 * Map error codes to HTTP status codes
 */
export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  // 400 Bad Request
  [ErrorCodes.INVALID_ACTION]: 400,
  [ErrorCodes.CANNOT_CHECK]: 400,
  [ErrorCodes.NOTHING_TO_CALL]: 400,
  [ErrorCodes.CANNOT_BET]: 400,
  [ErrorCodes.BET_TOO_SMALL]: 400,
  [ErrorCodes.CANNOT_RAISE]: 400,
  [ErrorCodes.CANNOT_RERAISE]: 400,
  [ErrorCodes.RAISE_TOO_SMALL]: 400,
  [ErrorCodes.CANNOT_DEAL]: 400,
  [ErrorCodes.NOT_ENOUGH_PLAYERS]: 400,
  [ErrorCodes.INVALID_SEAT]: 400,
  [ErrorCodes.SEAT_OCCUPIED]: 400,
  [ErrorCodes.INVALID_STACK]: 400,
  [ErrorCodes.INVALID_AMOUNT]: 400,
  [ErrorCodes.INVALID_TIMESTAMP]: 400,
  [ErrorCodes.INVALID_BUY_IN]: 400,
  [ErrorCodes.NOT_SEATED]: 400,

  // 401 Unauthorized
  [ErrorCodes.UNAUTHORIZED]: 401,

  // 403 Forbidden
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.NOT_YOUR_TURN]: 403,

  // 404 Not Found
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.TABLE_NOT_FOUND]: 404,
  [ErrorCodes.PLAYER_NOT_FOUND]: 404,

  // 409 Conflict
  [ErrorCodes.PLAYER_NOT_ACTIVE]: 409,
  [ErrorCodes.NO_CHIPS]: 409,

  // 422 Unprocessable Entity
  [ErrorCodes.INSUFFICIENT_FUNDS]: 422,

  // 429 Too Many Requests
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 429,

  // 500 Internal Server Error
  [ErrorCodes.INTERNAL_ERROR]: 500,

  // 503 Service Unavailable
  [ErrorCodes.SERVICE_UNAVAILABLE]: 503,
};

/**
 * Get HTTP status code for an error code
 */
export function getStatusCodeForError(code: ErrorCode): number {
  return ERROR_STATUS_MAP[code] ?? 500;
}
