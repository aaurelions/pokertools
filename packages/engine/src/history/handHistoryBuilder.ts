/**
 * Build hand history from game state and action history
 */

import {
  GameState,
  Street,
  Action,
  ActionType,
  HandHistory,
  HandHistoryPlayer,
  StreetHistory,
  HandHistoryActionRecord,
  WinnerRecord,
} from "@pokertools/types";

/**
 * Build complete hand history from final game state
 * Call this after a hand is complete (winners determined)
 */
export function buildHandHistory(
  finalState: GameState,
  tableName = "Table 1",
  gameType: "Cash" | "Tournament" = "Cash"
): HandHistory {
  const players = buildPlayerHistory(finalState);
  const streets = buildStreetHistory(finalState);
  const winners = buildWinnerHistory(finalState);

  const totalPot = winners.reduce((sum, w) => sum + w.amount, 0);

  return {
    handId: finalState.handId,
    timestamp: finalState.timestamp,
    tableName,
    gameType,
    stakes: {
      smallBlind: finalState.smallBlind,
      bigBlind: finalState.bigBlind,
      ante: finalState.ante,
    },
    maxPlayers: finalState.maxPlayers,
    buttonSeat: finalState.buttonSeat ?? 0,
    players,
    streets,
    winners,
    totalPot,
  };
}

/**
 * Build player history records
 */
function buildPlayerHistory(state: GameState): HandHistoryPlayer[] {
  const players: HandHistoryPlayer[] = [];

  for (const player of state.players) {
    if (!player) continue;

    // Calculate starting stack (current + invested)
    const startingStack = player.stack + player.totalInvestedThisHand;

    // Only include cards if they are fully visible (no masked/null cards)
    const hasMaskedCards = player.hand?.some((c) => c === null);
    const cards = player.hand && !hasMaskedCards ? (player.hand as string[]) : undefined;

    players.push({
      seat: player.seat,
      name: player.name,
      startingStack,
      endingStack: player.stack,
      cards,
    });
  }

  return players;
}

/**
 * Build street-by-street history
 */
function buildStreetHistory(state: GameState): StreetHistory[] {
  const streets: StreetHistory[] = [];
  const actionsByStreet = groupActionsByStreet(state);

  // Build history for each street that had actions
  for (const [street, actions] of actionsByStreet) {
    const board = getBoardForStreet(state, street);
    const pot = calculatePotAtStreet(actions);

    streets.push({
      street,
      board,
      actions,
      pot,
    });
  }

  return streets;
}

/**
 * Group actions by street
 */
function groupActionsByStreet(state: GameState): Map<Street, HandHistoryActionRecord[]> {
  const grouped = new Map<Street, HandHistoryActionRecord[]>();

  // Initialize with all streets
  grouped.set(Street.PREFLOP, []);
  grouped.set(Street.FLOP, []);
  grouped.set(Street.TURN, []);
  grouped.set(Street.RIVER, []);
  grouped.set(Street.SHOWDOWN, []);

  // Group action history by street
  for (const record of state.actionHistory) {
    if (record.seat === null) continue; // Skip table-level actions

    const street = (record.street as Street) ?? state.street;
    const existing = grouped.get(street) ?? [];

    const actionRecord: HandHistoryActionRecord = {
      seat: record.seat,
      playerName: state.players[record.seat]?.name ?? `Player ${record.seat}`,
      action: record.action,
      amount: getActionAmount(record.action),
      isAllIn: isAllInAction(record.action, state, record.seat),
      timestamp: record.action.timestamp ?? 0,
    };

    existing.push(actionRecord);
    grouped.set(street, existing);
  }

  // Remove empty streets
  for (const [street, actions] of grouped) {
    if (actions.length === 0) {
      grouped.delete(street);
    }
  }

  return grouped;
}

/**
 * Get board cards for a given street
 */
function getBoardForStreet(state: GameState, street: Street): readonly string[] {
  switch (street) {
    case Street.PREFLOP:
      return [];
    case Street.FLOP:
      return state.board.slice(0, 3);
    case Street.TURN:
      return state.board.slice(0, 4);
    case Street.RIVER:
    case Street.SHOWDOWN:
      return state.board.slice(0, 5);
    default:
      return [];
  }
}

/**
 * Calculate pot size at end of street actions
 */
function calculatePotAtStreet(actions: HandHistoryActionRecord[]): number {
  let pot = 0;

  for (const action of actions) {
    if (action.amount) {
      pot += action.amount;
    }
  }

  return pot;
}

/**
 * Extract amount from action
 */
function getActionAmount(action: Action): number | undefined {
  switch (action.type) {
    case ActionType.BET:
    case ActionType.RAISE:
      return action.amount;
    case ActionType.CALL:
      // Call amount would need to be tracked in action history
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Check if action resulted in all-in
 */
function isAllInAction(action: Action, state: GameState, seat: number): boolean {
  const player = state.players[seat];
  if (!player) return false;

  return player.stack === 0 && player.totalInvestedThisHand > 0;
}

/**
 * Build winner records
 */
function buildWinnerHistory(state: GameState): WinnerRecord[] {
  if (!state.winners) return [];

  return state.winners.map((winner) => {
    const player = state.players[winner.seat];

    return {
      seat: winner.seat,
      playerName: player?.name ?? `Player ${winner.seat}`,
      amount: winner.amount,
      hand: winner.hand ?? undefined,
      handRank: winner.handRank ?? undefined,
    };
  });
}
