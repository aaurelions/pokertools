/**
 * Player status within a hand
 */
export const enum PlayerStatus {
  ACTIVE = "ACTIVE", // In hand, can act
  FOLDED = "FOLDED", // Folded this hand
  ALL_IN = "ALL_IN", // No more chips to bet
  SITTING_OUT = "SITTING_OUT", // Not playing
  WAITING = "WAITING", // At table but not in hand yet
  BUSTED = "BUSTED", // Stack = 0
  RESERVED = "RESERVED", // Seat reserved, awaiting payment confirmation
}

/**
 * Sit-in timing options for cash games
 */
export const enum SitInOption {
  IMMEDIATE = "IMMEDIATE", // Sit in immediately
  WAIT_FOR_BB = "WAIT_FOR_BB", // Wait until Big Blind position to sit in
}

/**
 * Represents a player seated at the table
 */
export interface Player {
  readonly id: string; // Unique player ID
  readonly name: string; // Player display name
  readonly seat: number; // 0-based seat index (0-9)
  readonly stack: number; // Current chips (integer only)
  readonly hand: ReadonlyArray<string | null> | null; // Hole cards ["As", "Kh"], [null, null] (masked), or null (no hand)
  readonly shownCards: readonly number[] | null; // Indices of cards shown at showdown [0, 1] or [0] or null if mucked
  readonly status: PlayerStatus; // Current status in hand
  readonly betThisStreet: number; // Amount bet this street
  readonly totalInvestedThisHand: number; // Total invested this hand (for side pots)
  readonly isSittingOut: boolean; // Sitting out flag
  readonly timeBank: number; // Seconds of time bank remaining
  readonly pendingAddOn: number; // Chips waiting to be added at start of next hand (rebuy/top-up)
  readonly sitInOption: SitInOption; // When to sit in (cash games only)
  readonly reservationExpiry: number | null; // Timestamp when seat reservation expires (null if not reserved)
}
