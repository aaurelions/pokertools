/**
 * Game constants and configuration values
 * Centralizes magic numbers for maintainability
 */

/**
 * Maximum number of previous states to keep for undo functionality
 */
export const MAX_UNDO_HISTORY = 50;

/**
 * Percentage divisor for converting percentages to decimal
 * e.g., 5% = 5 / PERCENTAGE_DIVISOR = 0.05
 */
export const PERCENTAGE_DIVISOR = 100;

/**
 * Number of cards to burn before dealing community cards on each street
 */
export const BURN_CARDS_PER_STREET = 1;

/**
 * Number of cards to deal on the flop
 */
export const FLOP_CARD_COUNT = 3;

/**
 * Number of cards to deal on the turn
 */
export const TURN_CARD_COUNT = 1;

/**
 * Number of cards to deal on the river
 */
export const RIVER_CARD_COUNT = 1;

/**
 * Number of hole cards dealt to each player in Texas Hold'em
 */
export const HOLE_CARDS_PER_PLAYER = 2;

/**
 * Maximum clock drift tolerance for timestamp validation (milliseconds)
 * Allows for small differences in server clocks
 */
export const TIMESTAMP_FUTURE_TOLERANCE_MS = 1000;
