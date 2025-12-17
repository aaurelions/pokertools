import { ActionRecord, GameState, Player, Pot, TableConfig, Winner } from "@pokertools/types";

/**
 * Snapshot format (JSON-serializable)
 */
export interface Snapshot {
  readonly config: TableConfig;
  readonly players: Array<Player | null>;
  readonly maxPlayers: number;
  readonly handNumber: number;
  readonly buttonSeat: number | null;
  readonly deck: number[];
  readonly board: string[];
  readonly street: string;
  readonly pots: Pot[];
  readonly currentBets: Record<number, number>;
  readonly minRaise: number;
  readonly lastRaiseAmount: number;
  readonly actionTo: number | null;
  readonly lastAggressorSeat: number | null;
  readonly activePlayers: number[];
  readonly winners: Winner[] | null;
  readonly rakeThisHand: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly blindLevel: number;
  readonly timeBanks: Record<number, number>;
  readonly timeBankActiveSeat: number | null;
  readonly actionHistory: ActionRecord[];
  readonly previousStates: Snapshot[]; // Truncated
  readonly timestamp: number;
  readonly handId: string;
}

/**
 * Create JSON-serializable snapshot of game state
 * Converts Maps to objects and truncates history
 */
export function createSnapshot(state: GameState): Snapshot {
  // Convert Maps to plain objects
  const currentBets: Record<number, number> = {};
  for (const [seat, bet] of state.currentBets.entries()) {
    currentBets[seat] = bet;
  }

  const timeBanks: Record<number, number> = {};
  for (const [seat, time] of state.timeBanks.entries()) {
    timeBanks[seat] = time;
  }

  // Truncate previous states (keep last 10 only)
  const previousStates = state.previousStates.slice(-10).map((s) => createSnapshot(s));

  return {
    config: state.config,
    players: [...state.players],
    maxPlayers: state.maxPlayers,
    handNumber: state.handNumber,
    buttonSeat: state.buttonSeat,
    deck: Array.from(state.deck),
    board: Array.from(state.board),
    street: state.street,
    pots: Array.from(state.pots),
    currentBets,
    minRaise: state.minRaise,
    lastRaiseAmount: state.lastRaiseAmount,
    actionTo: state.actionTo,
    lastAggressorSeat: state.lastAggressorSeat,
    activePlayers: Array.from(state.activePlayers),
    winners: state.winners ? Array.from(state.winners) : null,
    rakeThisHand: state.rakeThisHand,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    ante: state.ante,
    blindLevel: state.blindLevel,
    timeBanks,
    timeBankActiveSeat: state.timeBankActiveSeat,
    actionHistory: Array.from(state.actionHistory),
    previousStates,
    timestamp: state.timestamp,
    handId: state.handId,
  };
}

/**
 * Restore game state from snapshot
 */
export function restoreFromSnapshot(snapshot: Snapshot): GameState {
  // Convert plain objects back to Maps
  const currentBets = new Map<number, number>();
  for (const [seatStr, bet] of Object.entries(snapshot.currentBets)) {
    currentBets.set(parseInt(seatStr), bet);
  }

  const timeBanks = new Map<number, number>();
  for (const [seatStr, time] of Object.entries(snapshot.timeBanks)) {
    timeBanks.set(parseInt(seatStr), time);
  }

  // Restore previous states recursively
  const previousStates = snapshot.previousStates.map((s) => restoreFromSnapshot(s));

  return {
    ...snapshot,
    currentBets,
    timeBanks,
    timeBankActiveSeat: snapshot.timeBankActiveSeat ?? null, // Backward compatibility
    previousStates,
    rakeThisHand: snapshot.rakeThisHand || 0, // Add missing field with default
  } as GameState;
}

/**
 * Serialize snapshot to JSON string
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Deserialize JSON string to snapshot
 */
export function deserializeSnapshot(json: string): Snapshot {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return JSON.parse(json);
}

/**
 * Validate snapshot integrity
 */
export function validateSnapshot(snapshot: Snapshot): boolean {
  try {
    // Basic validation
    if (!snapshot.handId) return false;
    if (snapshot.maxPlayers < 2 || snapshot.maxPlayers > 10) return false;
    if (snapshot.players.length !== snapshot.maxPlayers) return false;

    return true;
  } catch {
    return false;
  }
}
