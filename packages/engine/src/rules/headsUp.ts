import { GameState, Street, PlayerStatus } from "@pokertools/types";

/**
 * Determine if the game is heads-up (exactly 2 seated players)
 * This checks seated players, not just active in current hand,
 * because heads-up rules apply to the table structure, not hand state
 */
export function isHeadsUp(state: GameState): boolean {
  const seatedPlayers = state.players.filter((p) => p !== null);
  return seatedPlayers.length === 2;
}

/**
 * Get heads-up action order for a given street
 * In heads-up:
 * - Button IS small blind
 * - Button acts FIRST preflop
 * - Button acts LAST postflop
 */
export function getHeadsUpActionOrder(state: GameState, street: Street): number[] {
  if (state.buttonSeat === null) {
    return [];
  }

  const buttonSeat = state.buttonSeat;
  const activePlayers = state.players
    .map((p, seat) => ({ player: p, seat }))
    .filter(
      ({ player }) =>
        player && (player.status === PlayerStatus.ACTIVE || player.status === PlayerStatus.ALL_IN)
    )
    .map(({ seat }) => seat);

  if (activePlayers.length !== 2) {
    return activePlayers;
  }

  // Find the two seats
  const [seat1, seat2] = activePlayers.sort((a, b) => a - b);
  const otherSeat = seat1 === buttonSeat ? seat2 : seat1;

  if (street === Street.PREFLOP) {
    // Button acts first preflop
    return [buttonSeat, otherSeat];
  } else {
    // Button acts last postflop (other player first)
    return [otherSeat, buttonSeat];
  }
}
