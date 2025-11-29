import { GameState, Street, PlayerStatus } from "@pokertools/types";
import { getNextSeat } from "../utils/positioning";
import { isHeadsUp, getHeadsUpActionOrder } from "./headsUp";
import { getBlindPositions } from "./blinds";

/**
 * Determine the next player to act
 * Returns seat number or null if action is complete
 */
export function getNextToAct(state: GameState): number | null {
  // Special case: heads-up has different rules
  if (isHeadsUp(state)) {
    return getNextToActHeadsUp(state);
  }

  return getNextToActNormal(state);
}

/**
 * Get next to act in normal (3+ player) game
 */
function getNextToActNormal(state: GameState): number | null {
  if (state.actionTo === null) {
    // Action not started, find first to act
    return getFirstToAct(state);
  }

  const currentBet = getCurrentBet(state);
  let seat = getNextSeat(state.actionTo, state.maxPlayers);
  const startSeat = state.actionTo;
  let foundActionable = false;

  // Search for next player who can act
  while (seat !== startSeat) {
    const player = state.players[seat];

    // Skip if: no player, folded, all-in, or busted
    if (!player || player.status !== PlayerStatus.ACTIVE || player.stack === 0) {
      seat = getNextSeat(seat, state.maxPlayers);
      continue;
    }

    // Player can act if:
    // 1. They haven't acted this street yet, OR
    // 2. Current bet is higher than their bet
    const playerBet = state.currentBets.get(seat) ?? 0;

    if (playerBet < currentBet) {
      return seat; // Player needs to respond to bet
    }

    // Player has matched current bet
    // Check if they've already acted
    if (!hasActedThisStreet(state, seat)) {
      return seat; // Player hasn't acted yet
    }

    foundActionable = true;
    seat = getNextSeat(seat, state.maxPlayers);
  }

  // Full circle - check if everyone has acted and matched bets
  if (foundActionable && isActionComplete(state)) {
    return null; // Action complete
  }

  return null;
}

/**
 * Get next to act in heads-up game
 */
function getNextToActHeadsUp(state: GameState): number | null {
  if (state.buttonSeat === null) {
    return null;
  }

  const actionOrder = getHeadsUpActionOrder(state, state.street);

  if (actionOrder.length === 0) {
    return null;
  }

  // If action hasn't started, return first player
  if (state.actionTo === null) {
    return actionOrder[0];
  }

  const currentBet = getCurrentBet(state);

  // Check both players
  for (const seat of actionOrder) {
    const player = state.players[seat];

    if (!player || player.status !== PlayerStatus.ACTIVE || player.stack === 0) {
      continue;
    }

    const playerBet = state.currentBets.get(seat) ?? 0;

    if (playerBet < currentBet || !hasActedThisStreet(state, seat)) {
      return seat;
    }
  }

  return null; // Action complete
}

/**
 * Get first player to act for the current street
 */
export function getFirstToAct(state: GameState): number | null {
  if (state.buttonSeat === null) {
    return null;
  }

  if (isHeadsUp(state)) {
    const order = getHeadsUpActionOrder(state, state.street);
    if (order.length > 0) {
      return order[0];
    }
    return null;
  }

  if (state.street === Street.PREFLOP) {
    // Preflop: First to act is UTG (Left of BB)
    // We use blind positions to find the BB seat
    const blinds = getBlindPositions(state);

    if (!blinds) {
      // Fallback if no blinds found (shouldn't happen)
      return getNextActionableSeat(state.buttonSeat, state);
    }

    // UTG is the next actionable seat after Big Blind
    return getNextActionableSeat(blinds.bigBlindSeat, state);
  } else {
    // Postflop: First to act is left of Button
    // We start scanning immediately after button
    // (Button might be dead/empty, but the position exists)
    return getNextActionableSeat(state.buttonSeat, state);
  }
}

/**
 * Find next actionable player starting from the seat AFTER the given startSeat
 */
function getNextActionableSeat(startSeat: number, state: GameState): number | null {
  let seat = getNextSeat(startSeat, state.maxPlayers);
  const endSeat = startSeat;

  // Scan full circle
  while (seat !== endSeat) {
    const player = state.players[seat];

    if (player && player.status === PlayerStatus.ACTIVE && player.stack > 0) {
      return seat;
    }

    seat = getNextSeat(seat, state.maxPlayers);
  }

  return null;
}

/**
 * Get current highest bet this street
 */
function getCurrentBet(state: GameState): number {
  let maxBet = 0;

  for (const bet of state.currentBets.values()) {
    if (bet > maxBet) {
      maxBet = bet;
    }
  }

  return maxBet;
}

/**
 * Check if action is complete (everyone has acted and matched bets or folded/all-in)
 */
export function isActionComplete(state: GameState): boolean {
  const currentBet = getCurrentBet(state);
  let activeCount = 0;
  let actedCount = 0;

  for (let seat = 0; seat < state.players.length; seat++) {
    const player = state.players[seat];

    if (!player) continue;

    // Count active players who can still act
    if (player.status === PlayerStatus.ACTIVE && player.stack > 0) {
      activeCount++;

      const playerBet = state.currentBets.get(seat) ?? 0;

      // Player has matched bet and acted
      if (playerBet === currentBet && hasActedThisStreet(state, seat)) {
        actedCount++;
      }
    }
  }

  // Action complete if all active players have acted and matched bets
  // OR if there are no active players (all all-in or folded) during an active hand
  if (activeCount === 0) {
    // Only return true if we're in a hand (not pre-deal)
    // Check: Are there all-in players with bets?
    const allInPlayers = state.players.filter((p) => p && p.status === PlayerStatus.ALL_IN);
    return allInPlayers.length > 0 && state.currentBets.size > 0;
  }

  return activeCount > 0 && activeCount === actedCount;
}

/**
 * Check if a player has acted this street
 * This is tracked by checking if they appear in the action history for this street
 */
function hasActedThisStreet(state: GameState, seat: number): boolean {
  // Find actions from current street
  const streetStartIndex = findStreetStartIndex(state);

  for (let i = streetStartIndex; i < state.actionHistory.length; i++) {
    if (state.actionHistory[i].seat === seat) {
      return true;
    }
  }

  return false;
}

/**
 * Find the index in action history where current street started
 * Counts backwards from the end until we find a different street
 */
function findStreetStartIndex(state: GameState): number {
  const currentStreet = state.street;

  // Search backwards through action history
  for (let i = state.actionHistory.length - 1; i >= 0; i--) {
    const record = state.actionHistory[i];

    // If we find an action from a different street, the current street starts after it
    if (record.street && (record.street as Street) !== currentStreet) {
      return i + 1;
    }
  }

  // If all actions are from current street (or no street recorded), start from beginning
  return 0;
}
