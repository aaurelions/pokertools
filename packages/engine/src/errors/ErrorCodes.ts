/**
 * Standardized error codes for IllegalActionError
 *
 * Using a const enum pattern for:
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
