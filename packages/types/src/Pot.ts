/**
 * Pot type (main pot or side pot)
 */
export type PotType = "MAIN" | "SIDE";

/**
 * Represents a pot (main or side) in the game
 */
export interface Pot {
  readonly amount: number; // Total chips in this pot
  readonly eligibleSeats: readonly number[]; // Seats eligible to win
  readonly type: PotType; // Main or side pot
  readonly capPerPlayer: number; // Max contribution per player
}
