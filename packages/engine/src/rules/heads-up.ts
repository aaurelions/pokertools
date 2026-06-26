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

  // Check if button is one of the active players
  const isButtonActive = activePlayers.includes(buttonSeat);

  if (!isButtonActive) {
    // Dead button scenario - button is not one of the active players
    // In this case, the "button" for action purposes is the first active player
    // after the actual button position
    const effectiveButton = seat1 > buttonSeat || seat2 < buttonSeat ? seat1 : seat2;
    const otherSeat = effectiveButton === seat1 ? seat2 : seat1;

    if (street === Street.PREFLOP) {
      // Effective button acts first preflop
      return [effectiveButton, otherSeat];
    } else {
      // Effective button acts last postflop
      return [otherSeat, effectiveButton];
    }
  }

  // Normal case: button is one of the active players
  const otherSeat = seat1 === buttonSeat ? seat2 : seat1;

  if (street === Street.PREFLOP) {
    // Button acts first preflop
    return [buttonSeat, otherSeat];
  } else {
    // Button acts last postflop (other player first)
    return [otherSeat, buttonSeat];
  }
}
