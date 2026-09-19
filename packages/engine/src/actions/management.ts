import {
  GameState,
  SitAction,
  StandAction,
  AddChipsAction,
  ReserveSeatAction,
  Player,
  PlayerStatus,
  SitInOption,
  ActionType,
} from "@pokertools/types";
import { getPlayerById } from "../utils/positioning";
import { handleFold } from "./betting";

const DEFAULT_TIME_BANK_SECONDS = 30;

/**
 * Handle SIT action - add player to table
 */
export function handleSit(state: GameState, action: SitAction): GameState {
  const currentBaseline = (state as GameState & { initialChips?: number }).initialChips;
  const newPlayer: Player = {
    id: action.playerId,
    name: action.playerName,
    seat: action.seat,
    stack: action.stack,
    hand: null,
    shownCards: null,
    status: PlayerStatus.WAITING,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: state.config.timeBankSeconds ?? DEFAULT_TIME_BANK_SECONDS,
    pendingAddOn: 0,
    sitInOption: action.sitInOption ?? SitInOption.IMMEDIATE,
    reservationExpiry: null,
    pendingStand: false,
  };

  const newPlayers = [...state.players];
  newPlayers[action.seat] = newPlayer;

  const newTimeBanks = new Map(state.timeBanks);
  newTimeBanks.set(action.seat, newPlayer.timeBank);

  return {
    ...state,
    players: newPlayers,
    timeBanks: newTimeBanks,
    initialChips: typeof currentBaseline === "number" ? currentBaseline + action.stack : undefined,
    timestamp: action.timestamp!,
  };
}

/**
 * Handle STAND action - remove player from table
 */
export function handleStand(state: GameState, action: StandAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  let currentState = state;
  const { player, seat } = result;

  const handInProgress =
    currentState.handNumber > 0 &&
    currentState.street !== "SHOWDOWN" &&
    currentState.winners === null;
  const hasCommittedChips = player.totalInvestedThisHand > 0;

  if (handInProgress && (player.status === PlayerStatus.ACTIVE || hasCommittedChips)) {
    const originalActionTo = currentState.actionTo;

    // Active departures fold, but an out-of-turn departure must not advance
    // action past the player who was already due to act.
    if (player.status === PlayerStatus.ACTIVE) {
      currentState = handleFold(currentState, {
        type: ActionType.FOLD,
        playerId: player.id,
        timestamp: action.timestamp,
      });
      if (seat !== originalActionTo && currentState.winners === null) {
        currentState = { ...currentState, actionTo: originalActionTo };
      }
    }

    const leavingPlayer = currentState.players[seat]!;
    const chipsLeavingTable = leavingPlayer.stack;
    const currentBaseline = (currentState as GameState & { initialChips?: number }).initialChips;
    const newTimeBanks = new Map(currentState.timeBanks);
    newTimeBanks.delete(seat);

    // Once the hand has settled, or when the departing player committed no
    // chips, the seat can be removed immediately. Otherwise retain a zero-stack
    // folded placeholder until its committed chips are awarded.
    const mustRetainForSettlement =
      currentState.winners === null && leavingPlayer.totalInvestedThisHand > 0;
    const newPlayers = [...currentState.players];
    newPlayers[seat] = mustRetainForSettlement
      ? { ...leavingPlayer, stack: 0, pendingStand: true }
      : null;

    return {
      ...currentState,
      players: newPlayers,
      activePlayers: currentState.activePlayers.filter((activeSeat) => activeSeat !== seat),
      timeBanks: newTimeBanks,
      initialChips:
        typeof currentBaseline === "number" ? currentBaseline - chipsLeavingTable : undefined,
      timestamp: action.timestamp!,
    };
  }

  if (player.status === PlayerStatus.ACTIVE) {
    currentState = handleFold(currentState, {
      type: ActionType.FOLD,
      playerId: player.id,
      timestamp: action.timestamp,
    });
  }

  const chipsLeavingTable = currentState.players[seat]?.stack ?? 0;
  const currentBaseline = (currentState as GameState & { initialChips?: number }).initialChips;
  const newPlayers = [...currentState.players];
  newPlayers[seat] = null;

  // Remove from time banks
  const newTimeBanks = new Map(currentState.timeBanks);
  newTimeBanks.delete(seat);

  // Remove from active players if present
  // (Note: handleFold might have already moved them to FOLDED status,
  // but we ensure they are fully removed from tracking here)
  const newActivePlayers = currentState.activePlayers.filter((s) => s !== seat);

  return {
    ...currentState,
    players: newPlayers,
    activePlayers: newActivePlayers,
    timeBanks: newTimeBanks,
    initialChips:
      typeof currentBaseline === "number" ? currentBaseline - chipsLeavingTable : undefined,
    timestamp: action.timestamp!,
  };
}

/**
 * Handle ADD_CHIPS action - add chips to player's pending stack
 * Chips are held in pendingAddOn and will be merged into stack at start of next hand
 */
export function handleAddChips(state: GameState, action: AddChipsAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  const { player, seat } = result;
  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    pendingAddOn: player.pendingAddOn + action.amount,
  };

  return {
    ...state,
    players: newPlayers,
    timestamp: action.timestamp!,
  };
}

/**
 * Handle RESERVE_SEAT action - reserve a seat for a player
 * Marks the seat as RESERVED with an expiration timestamp
 * API can use this to lock a seat while processing payment
 */
export function handleReserveSeat(state: GameState, action: ReserveSeatAction): GameState {
  // Check if seat is already occupied
  if (state.players[action.seat] !== null) {
    return state;
  }

  const reservedPlayer: Player = {
    id: action.playerId,
    name: action.playerName,
    seat: action.seat,
    stack: 0,
    hand: null,
    shownCards: null,
    status: PlayerStatus.RESERVED,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: state.config.timeBankSeconds ?? DEFAULT_TIME_BANK_SECONDS,
    pendingAddOn: 0,
    sitInOption: SitInOption.IMMEDIATE,
    reservationExpiry: action.expiryTimestamp,
    pendingStand: false,
  };

  const newPlayers = [...state.players];
  newPlayers[action.seat] = reservedPlayer;

  return {
    ...state,
    players: newPlayers,
    timestamp: action.timestamp!,
  };
}
