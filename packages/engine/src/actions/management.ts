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

/**
 * Handle SIT action - add player to table
 */
export function handleSit(state: GameState, action: SitAction): GameState {
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
    timeBank: state.config.timeBankSeconds ?? 30,
    pendingAddOn: 0,
    sitInOption: action.sitInOption ?? SitInOption.IMMEDIATE,
    reservationExpiry: null,
  };

  const newPlayers = [...state.players];
  newPlayers[action.seat] = newPlayer;

  // Add to time banks
  const newTimeBanks = new Map(state.timeBanks);
  newTimeBanks.set(action.seat, newPlayer.timeBank);

  return {
    ...state,
    players: newPlayers,
    timeBanks: newTimeBanks,
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

  // 1. BEST PRACTICE: If the player is in a live hand, they must FOLD first.
  // This resolves the "ActionTo" pointer, potential winners, and pot eligibility
  // using the standard game rules defined in handleFold.
  const isLiveHand =
    currentState.handNumber > 0 &&
    currentState.street !== "SHOWDOWN" && // Not needed if hand is over
    (player.status === "ACTIVE" || player.status === "ALL_IN");

  if (isLiveHand) {
    // Execute a "Virtual Fold" to gracefully exit the hand
    currentState = handleFold(currentState, {
      type: ActionType.FOLD,
      playerId: player.id,
      timestamp: action.timestamp,
    });

    // NOTE: handleFold returns a new state where actionTo has already been
    // advanced to the next player. The invariant check will now pass.
  }

  // 2. Remove player from table (Standard Stand Logic)
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
    timeBank: state.config.timeBankSeconds ?? 30,
    pendingAddOn: 0,
    sitInOption: SitInOption.IMMEDIATE,
    reservationExpiry: action.expiryTimestamp,
  };

  const newPlayers = [...state.players];
  newPlayers[action.seat] = reservedPlayer;

  return {
    ...state,
    players: newPlayers,
    timestamp: action.timestamp!,
  };
}
