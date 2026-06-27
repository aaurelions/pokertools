/** Player status within a hand. */
export const enum PlayerStatus {
  /** In hand, can act. */
  ACTIVE = "ACTIVE",
  /** Folded this hand. */
  FOLDED = "FOLDED",
  /** No more chips to bet. */
  ALL_IN = "ALL_IN",
  /** Not playing. */
  SITTING_OUT = "SITTING_OUT",
  /** At table but not in hand yet. */
  WAITING = "WAITING",
  /** Stack = 0. */
  BUSTED = "BUSTED",
  /** Seat reserved, awaiting payment confirmation. */
  RESERVED = "RESERVED",
}

/** Sit-in timing options for cash games. */
export const enum SitInOption {
  /** Sit in immediately. */
  IMMEDIATE = "IMMEDIATE",
  /** Wait until Big Blind position to sit in. */
  WAIT_FOR_BB = "WAIT_FOR_BB",
}

/** Represents a player seated at the table. */
export interface Player {
  readonly id: string;
  readonly name: string;
  /** 0-based seat index (0-9). */
  readonly seat: number;
  /** Current chips (integer only). */
  readonly stack: number;
  /** Hole cards: ["As", "Kh"], [null, null] (masked), or null (no hand). */
  readonly hand: ReadonlyArray<string | null> | null;
  /** Indices of cards shown at showdown: [0, 1], [0], or null if mucked. */
  readonly shownCards: readonly number[] | null;
  readonly status: PlayerStatus;
  /** Amount bet on the current street. */
  readonly betThisStreet: number;
  /** Total invested this hand (drives side-pot calculations). */
  readonly totalInvestedThisHand: number;
  readonly isSittingOut: boolean;
  /** Seconds of time bank remaining. */
  readonly timeBank: number;
  /** Chips waiting to be added at start of next hand (rebuy/top-up). */
  readonly pendingAddOn: number;
  /** When to sit in (cash games only). */
  readonly sitInOption: SitInOption;
  /** Unix timestamp when seat reservation expires (null if not reserved). */
  readonly reservationExpiry: number | null;
}
