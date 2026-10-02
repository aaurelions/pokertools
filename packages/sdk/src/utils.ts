/**
 * Utility functions for the PokerTools SDK.
 *
 * Chips are integer game units — not cents and not dollars. The chip helpers
 * only format/parse canonical integer chip quantities: there is no implicit
 * currency symbol and no division by 100. Chain value is a separate asset
 * concern exposed through the canonical finance contracts.
 *
 * The table view helpers operate on the canonical `PublicWireState` /
 * `PublicWirePlayer` projection carried by a `SeatObservation` (the server's
 * per-seat decision boundary), never on the engine's Map-based `PublicState`.
 */

import type { PublicWirePlayer, PublicWireState } from "@pokertools/types";

/**
 * Structural projection of a canonical wire player consumed by the view
 * helpers. A `PublicWirePlayer` (from a server observation) satisfies it, and
 * callers may supply any object with the same scalar fields.
 */
export type ViewPlayer = Pick<PublicWirePlayer, "id" | "name" | "seat" | "stack" | "status">;

/**
 * Structural projection of a canonical wire state for seat-aware helpers.
 */
export interface ViewState {
  readonly players: ReadonlyArray<ViewPlayer | null>;
  readonly actionTo: number | null;
}

/**
 * Structural projection of the pot collection for `getTotalPot`.
 */
export interface ViewPotState {
  readonly pots: ReadonlyArray<Pick<PublicWireState["pots"][number], "amount">>;
}

/** Number formatting helper shared by the chip formatter. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a chip amount (integer game units) for display.
 *
 * Chips are never treated as currency and are never divided by 100. The
 * result is the grouped integer, so `100` → `"100"` and `1_000_000` →
 * `"1,000,000"`.
 *
 * @throws when `chips` is not a non-negative safe integer.
 */
export function formatChips(chips: number): string {
  if (!Number.isSafeInteger(chips) || chips < 0) {
    throw new Error(`formatChips expects a non-negative safe integer, received: ${chips}`);
  }
  return groupThousands(String(chips));
}

/**
 * Matches canonical chip text: plain digits, or digits with well-formed
 * comma grouping. Signs, decimals, currency symbols, exponents and any
 * trailing junk are rejected.
 */
const CHIP_TEXT_PATTERN = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;

/**
 * Parse a chip amount (integer game units) from display text.
 *
 * Accepts an optional comma grouping and surrounding whitespace. Rejects
 * currency symbols, signed values, fractions, exponent notation, unsafe
 * integers and trailing junk.
 *
 * @throws when `amount` is not a non-negative safe integer chip string.
 */
export function parseChips(amount: string): number {
  const trimmed = amount.trim();
  if (trimmed.length === 0 || !CHIP_TEXT_PATTERN.test(trimmed)) {
    throw new Error(`Invalid chip amount: ${amount}`);
  }
  const value = Number(trimmed.replace(/,/g, ""));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid chip amount: ${amount}`);
  }
  return value;
}

/**
 * Get the player whose turn it is
 */
export function getActivePlayer(state: ViewState): ViewPlayer | null {
  if (state.actionTo === null) {
    return null;
  }
  return state.players[state.actionTo] ?? null;
}

/**
 * Get player by ID
 */
export function getPlayerById(state: ViewState, playerId: string): ViewPlayer | null {
  return state.players.find((p) => p?.id === playerId) ?? null;
}

/**
 * Get player seat index by ID
 */
export function getPlayerSeat(state: ViewState, playerId: string): number | null {
  const index = state.players.findIndex((p) => p?.id === playerId);
  return index === -1 ? null : index;
}

/**
 * Check if it's a specific player's turn
 */
export function isPlayerTurn(state: ViewState, playerId: string): boolean {
  if (state.actionTo === null) {
    return false;
  }
  const player = state.players[state.actionTo];
  return player?.id === playerId;
}

/**
 * Get total pot size (main pot + side pots)
 */
export function getTotalPot(state: ViewPotState): number {
  return state.pots.reduce((sum, pot) => sum + pot.amount, 0);
}

/**
 * Get number of active players (not folded, has chips)
 */
export function getActivePlayers(state: ViewState): ViewPlayer[] {
  return state.players.filter(
    (p): p is ViewPlayer => p !== null && p.status !== "FOLDED" && p.stack > 0
  );
}

/**
 * Get number of players in hand (not folded)
 */
export function getPlayersInHand(state: ViewState): ViewPlayer[] {
  return state.players.filter((p): p is ViewPlayer => p !== null && p.status !== "FOLDED");
}

/**
 * Card suit to emoji
 */
export function suitToEmoji(suit: string): string {
  const suits: Record<string, string> = {
    s: "♠",
    h: "♥",
    d: "♦",
    c: "♣",
  };
  return suits[suit.toLowerCase()] ?? suit;
}

/**
 * Format card for display (e.g., "As" -> "A♠")
 */
export function formatCard(card: string): string {
  if (card.length !== 2) {
    return card;
  }
  const rank = card[0].toUpperCase();
  const suit = suitToEmoji(card[1]);
  return `${rank}${suit}`;
}

/**
 * Format card array for display
 */
export function formatCards(cards: Array<string | null> | null): string {
  if (!cards) {
    return "🂠🂠";
  }
  return cards.map((c) => (c ? formatCard(c) : "🂠")).join(" ");
}

/**
 * Get street display name
 */
export function getStreetName(street: string): string {
  const names: Record<string, string> = {
    PREFLOP: "Pre-Flop",
    FLOP: "Flop",
    TURN: "Turn",
    RIVER: "River",
    SHOWDOWN: "Showdown",
  };
  return names[street] ?? street;
}

/**
 * Check if game is in showdown phase
 */
export function isShowdown(state: Pick<PublicWireState, "street">): boolean {
  return state.street === "SHOWDOWN";
}

/**
 * Check if hand is complete (has winners)
 */
export function isHandComplete(state: Pick<PublicWireState, "winners">): boolean {
  return state.winners !== undefined && state.winners !== null;
}

/**
 * Abbreviate large numbers (e.g., 1000 -> "1K")
 */
export function abbreviateNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toString();
}
