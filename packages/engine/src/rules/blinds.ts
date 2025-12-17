import { GameState } from "@pokertools/types";
import { getNextSeat } from "../utils/positioning";
import { isHeadsUp } from "./headsUp";

/**
 * Result of blind posting calculation
 */
export interface BlindPositions {
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
}

/**
 * Determine which seats should post blinds
 *
 * Heads-Up (2 players):
 * - SB = button (button IS small blind)
 * - BB = other player
 *
 * Normal (Dead Button Rule):
 * - SB = Button + 1 (Can be empty -> Dead Small Blind)
 * - BB = Next Occupied Seat after SB
 *
 * For cash games: Skips sitting-out players (unless they are in tournament mode)
 */
export function getBlindPositions(state: GameState): BlindPositions | null {
  if (state.buttonSeat === null) {
    return null;
  }

  const buttonSeat = state.buttonSeat;
  const isTournament = !!state.config.blindStructure;

  // Heads-up specific logic (Button is SB)
  if (isHeadsUp(state)) {
    const bbSeat = getNextActiveOrOccupiedSeat(
      buttonSeat,
      state.players,
      state.maxPlayers,
      isTournament
    );

    if (bbSeat === null) {
      return null;
    }

    return {
      smallBlindSeat: buttonSeat,
      bigBlindSeat: bbSeat,
    };
  }

  // Normal Play (Dead Button / Dead Small Blind Logic)

  // 1. SB is ALWAYS the immediate next seat, even if empty
  const sbSeat = getNextSeat(buttonSeat, state.maxPlayers);

  // 2. BB is the next ACTIVE player after the SB position
  // In cash games, skip sitting-out players
  // In tournaments, include sitting-out players (they must post blinds)
  const bbSeat = getNextActiveOrOccupiedSeat(sbSeat, state.players, state.maxPlayers, isTournament);

  if (bbSeat === null) {
    return null;
  }

  return {
    smallBlindSeat: sbSeat,
    bigBlindSeat: bbSeat,
  };
}

/**
 * Get next seat that is occupied and (if cash game) not sitting out
 */
function getNextActiveOrOccupiedSeat(
  currentSeat: number,
  players: ReadonlyArray<import("@pokertools/types").Player | null>,
  maxPlayers: number,
  isTournament: boolean
): number | null {
  let seat = getNextSeat(currentSeat, maxPlayers);
  const startSeat = currentSeat;

  while (seat !== startSeat) {
    const player = players[seat];
    if (player !== null && player.stack > 0) {
      // In tournaments, include sitting-out players (they must blind off)
      // In cash games, skip sitting-out players
      if (isTournament || !player.isSittingOut) {
        return seat;
      }
    }
    seat = getNextSeat(seat, maxPlayers);
  }

  return null; // No eligible seats
}

/**
 * Calculate blind amounts for antes
 */
export function calculateAntes(state: GameState): Map<number, number> {
  const antes = new Map<number, number>();

  if (state.ante === 0) {
    return antes;
  }

  // All active players post antes
  for (let seat = 0; seat < state.players.length; seat++) {
    const player = state.players[seat];
    if (player && player.stack > 0) {
      const anteAmount = Math.min(player.stack, state.ante);
      antes.set(seat, anteAmount);
    }
  }

  return antes;
}
