/**
 * Utility functions for the PokerTools SDK
 */

 

import type { PublicState, PublicPlayer } from "@pokertools/types";

/**
 * Format chip amount to display string
 * @param chips - Amount in cents (1 chip = 1 cent)
 * @param currency - Currency symbol (default: "$")
 */
export function formatChips(chips: number, currency = "$"): string {
  const dollars = chips / 100;
  return `${currency}${dollars.toFixed(2)}`;
}

/**
 * Parse display amount to chips (cents)
 * @param amount - Display amount string (e.g., "$10.50", "10.50", "1050")
 */
export function parseChips(amount: string): number {
  // Remove currency symbols and whitespace
  const cleaned = amount.replace(/[$€£¥,\s]/g, "");
  const value = parseFloat(cleaned);

  if (isNaN(value)) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  // If it looks like it's already in cents (integer), return as-is
  if (Number.isInteger(value) && value >= 100) {
    return value;
  }

  // Otherwise, convert from dollars to cents
  return Math.round(value * 100);
}

/**
 * Get the player whose turn it is
 */
export function getActivePlayer(state: PublicState): PublicPlayer | null {
  if (state.actionTo === null) {
    return null;
  }
  return state.players[state.actionTo] ?? null;
}

/**
 * Get player by ID
 */
export function getPlayerById(state: PublicState, playerId: string): PublicPlayer | null {
  return state.players.find((p) => p?.id === playerId) ?? null;
}

/**
 * Get player seat index by ID
 */
export function getPlayerSeat(state: PublicState, playerId: string): number | null {
  const index = state.players.findIndex((p) => p?.id === playerId);
  return index === -1 ? null : index;
}

/**
 * Check if it's a specific player's turn
 */
export function isPlayerTurn(state: PublicState, playerId: string): boolean {
  if (state.actionTo === null) {
    return false;
  }
  const player = state.players[state.actionTo];
  return player?.id === playerId;
}

/**
 * Get the amount needed to call
 */
export function getCallAmount(state: PublicState, playerId: string): number {
  const player = getPlayerById(state, playerId);
  if (!player) {
    return 0;
  }

  const currentBet = player.betThisStreet;
  const activePlayers = state.players.filter((p): p is PublicPlayer => p !== null);
  const bets = activePlayers.map((p) => p.betThisStreet);
   
  const highestBet = Math.max(...bets);

  return Math.min(highestBet - currentBet, player.stack);
}

/**
 * Get minimum raise amount
 */
export function getMinRaise(state: PublicState): number {
  return state.minRaise ?? state.config.bigBlind;
}

/**
 * Check if player can check
 */
export function canCheck(state: PublicState, playerId: string): boolean {
  const player = getPlayerById(state, playerId);
  if (!player || !isPlayerTurn(state, playerId)) {
    return false;
  }

  const currentBet = player.betThisStreet;
  const activePlayers = state.players.filter((p): p is PublicPlayer => p !== null);
  const bets = activePlayers.map((p) => p.betThisStreet);
   
  const highestBet = Math.max(...bets);

  return currentBet >= highestBet;
}

/**
 * Check if player can bet (no prior bets this round)
 */
export function canBet(state: PublicState, playerId: string): boolean {
  const player = getPlayerById(state, playerId);
  if (!player || !isPlayerTurn(state, playerId)) {
    return false;
  }

  const activePlayers = state.players.filter((p): p is PublicPlayer => p !== null);
  const bets = activePlayers.map((p) => p.betThisStreet);
   
  const highestBet = Math.max(...bets);

  return highestBet === 0 && player.stack > 0;
}

/**
 * Get total pot size (main pot + side pots)
 */
export function getTotalPot(state: PublicState): number {
  return state.pots.reduce((sum, pot) => sum + pot.amount, 0);
}

/**
 * Get number of active players (not folded, has chips)
 */
export function getActivePlayers(state: PublicState): PublicPlayer[] {
  return state.players.filter(
    (p): p is PublicPlayer => p !== null && p.status !== "FOLDED" && p.stack > 0
  );
}

/**
 * Get number of players in hand (not folded)
 */
export function getPlayersInHand(state: PublicState): PublicPlayer[] {
  return state.players.filter(
    (p): p is PublicPlayer => p !== null && p.status !== "FOLDED"
  );
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
export function isShowdown(state: PublicState): boolean {
  return state.street === "SHOWDOWN";
}

/**
 * Check if hand is complete (has winners)
 */
export function isHandComplete(state: PublicState): boolean {
  return state.winners !== undefined && state.winners !== null;
}

/**
 * Calculate pot odds as a ratio
 */
export function getPotOdds(state: PublicState, playerId: string): number {
  const callAmount = getCallAmount(state, playerId);
  if (callAmount === 0) {
    return Infinity;
  }
  return getTotalPot(state) / callAmount;
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

