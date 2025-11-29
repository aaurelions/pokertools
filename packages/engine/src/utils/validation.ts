/**
 * Validation utilities for chip amounts and other game values
 */

import { IllegalActionError } from "../errors/IllegalActionError";
import { ErrorCodes } from "../errors/ErrorCodes";
import { TIMESTAMP_FUTURE_TOLERANCE_MS } from "./constants";

/**
 * Validate that a chip amount is a non-negative integer
 * Prevents fractional chips and negative amounts
 *
 * @param amount The chip amount to validate
 * @param context Description of what this amount represents (for error messages)
 * @throws IllegalActionError if amount is invalid
 */
export function validateChipAmount(amount: number, context: string): void {
  if (!Number.isFinite(amount)) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_AMOUNT,
      `${context}: ${amount} is not a valid number`,
      { amount, context }
    );
  }

  if (!Number.isInteger(amount)) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_AMOUNT,
      `${context}: ${amount} must be an integer (fractional chips not allowed)`,
      { amount, context }
    );
  }

  if (amount < 0) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_AMOUNT,
      `${context}: ${amount} cannot be negative`,
      { amount, context }
    );
  }
}

/**
 * Validate that a timestamp is valid and not in the future
 *
 * @param timestamp The timestamp to validate
 * @param previousTimestamp The previous action's timestamp (for monotonic check)
 * @throws IllegalActionError if timestamp is invalid
 */
export function validateTimestamp(timestamp: number, previousTimestamp?: number): void {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new IllegalActionError(ErrorCodes.INVALID_TIMESTAMP, `Invalid timestamp: ${timestamp}`, {
      timestamp,
    });
  }

  // Allow some clock drift tolerance for "future" timestamps
  const now = Date.now() + TIMESTAMP_FUTURE_TOLERANCE_MS;
  if (timestamp > now) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_TIMESTAMP,
      `Timestamp ${timestamp} is in the future (current: ${Date.now()})`,
      { timestamp, currentTime: Date.now() }
    );
  }

  // Ensure timestamps are monotonically increasing (or equal for same-time actions)
  if (previousTimestamp !== undefined && timestamp < previousTimestamp) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_TIMESTAMP,
      `Timestamp ${timestamp} is before previous action timestamp ${previousTimestamp}`,
      { timestamp, previousTimestamp }
    );
  }
}
