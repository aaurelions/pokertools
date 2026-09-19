import { GameState, Street, PlayerStatus } from "@pokertools/types";

/**
 * Determine if the game is heads-up (exactly 2 funded seated players).
 * Zero-stack seats are dead seats until the table owner removes or reloads
 * them and must not prevent heads-up blind and action-order rules.
 */
export function isHeadsUp(state: GameState): boolean {
  const seatedPlayers = state.players.filter(
    (p) => p !== null && (p.stack > 0 || p.hand !== null || p.totalInvestedThisHand > 0)
  );
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
    .filter(({ player }) => player?.status === PlayerStatus.ACTIVE)
    .map(({ seat }) => seat);

  if (activePlayers.length !== 2) {
    return activePlayers;
  }

  // Find the two seats
  const [seat1, seat2] = activePlayers.sort((a, b) => a - b);

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
