import { GameState, Player, PlayerStatus } from "@pokertools/types";

/**
 * Get the next seat clockwise from current seat
 */
export function getNextSeat(currentSeat: number, maxPlayers: number): number {
  return (currentSeat + 1) % maxPlayers;
}

/**
 * Get distance from button to a seat (clockwise)
 */
export function getDistanceFromButton(
  seat: number,
  buttonSeat: number,
  maxPlayers: number
): number {
  if (seat >= buttonSeat) {
    return seat - buttonSeat;
  }
  return maxPlayers - buttonSeat + seat;
}

/**
 * Get all active player seats (not folded, not busted, has chips)
 */
export function getActivePlayers(state: GameState): number[] {
  const active: number[] = [];

  for (let i = 0; i < state.players.length; i++) {
    const player = state.players[i];
    if (player && player.status === PlayerStatus.ACTIVE && player.stack > 0) {
      active.push(i);
    }
  }

  return active;
}

/**
 * Get all seated players (including sitting out, but not empty seats)
 */
export function getSeatedPlayers(state: GameState): number[] {
  const seated: number[] = [];

  for (let i = 0; i < state.players.length; i++) {
    if (state.players[i] !== null) {
      seated.push(i);
    }
  }

  return seated;
}

/**
 * Find next occupied seat clockwise from current seat
 */
export function getNextOccupiedSeat(
  currentSeat: number,
  players: ReadonlyArray<Player | null>,
  maxPlayers: number
): number | null {
  let seat = getNextSeat(currentSeat, maxPlayers);
  const startSeat = currentSeat;

  while (seat !== startSeat) {
    if (players[seat] !== null && players[seat]!.stack > 0) {
      return seat;
    }
    seat = getNextSeat(seat, maxPlayers);
  }

  return null; // No other occupied seats
}

/**
 * Find next player who can act (ACTIVE status, not all-in)
 */
export function getNextActionableSeat(currentSeat: number, state: GameState): number | null {
  let seat = getNextSeat(currentSeat, state.maxPlayers);
  const startSeat = currentSeat;

  while (seat !== startSeat) {
    const player = state.players[seat];

    if (player && player.status === PlayerStatus.ACTIVE && player.stack > 0) {
      return seat;
    }

    seat = getNextSeat(seat, state.maxPlayers);
  }

  return null; // No actionable players
}

/**
 * Count players with specific status
 */
export function countPlayersByStatus(state: GameState, status: PlayerStatus): number {
  return state.players.filter((p) => p?.status === status).length;
}

/**
 * Get player by ID
 */
export function getPlayerById(
  state: GameState,
  playerId: string
): { player: Player; seat: number } | null {
  for (let seat = 0; seat < state.players.length; seat++) {
    const player = state.players[seat];
    if (player?.id === playerId) {
      return { player, seat };
    }
  }
  return null;
}
