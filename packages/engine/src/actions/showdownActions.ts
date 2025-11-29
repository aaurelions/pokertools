import {
  GameState,
  ShowAction,
  MuckAction,
  ActionRecord,
  ActionType,
  PlayerStatus,
  Street,
} from "@pokertools/types";
import { IllegalActionError } from "../errors/IllegalActionError";
import { ErrorCodes } from "../errors/ErrorCodes";

/**
 * Handle SHOW action - player reveals their cards at showdown
 */
export function handleShow(state: GameState, action: ShowAction): GameState {
  // Find player
  const player = state.players.find((p) => p?.id === action.playerId);
  if (!player) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }

  // Can only show at showdown
  if (state.street !== Street.SHOWDOWN) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_ACTION,
      `Can only show cards at showdown (current street: ${state.street})`,
      { playerId: action.playerId, street: state.street }
    );
  }

  // Player must not have folded
  if (player.status === PlayerStatus.FOLDED) {
    throw new IllegalActionError(ErrorCodes.INVALID_ACTION, `Cannot show cards after folding`, {
      playerId: action.playerId,
      status: player.status,
    });
  }

  // Player must have cards
  if (!player.hand) {
    throw new IllegalActionError(ErrorCodes.INVALID_ACTION, `Player has no cards to show`, {
      playerId: action.playerId,
    });
  }

  // Determine which cards to show
  let cardIndices: number[];
  if (action.cardIndices && action.cardIndices.length > 0) {
    // Validate indices are within bounds
    cardIndices = action.cardIndices.filter((i) => i >= 0 && i < player.hand!.length);
    if (cardIndices.length === 0) {
      return state; // Invalid indices
    }
  } else {
    // Default: show all cards
    cardIndices = Array.from({ length: player.hand.length }, (_, i) => i);
  }

  // Update player's shown cards
  const newPlayers = [...state.players];
  newPlayers[player.seat] = {
    ...player,
    shownCards: cardIndices,
  };

  const actionRecord: ActionRecord = {
    action: {
      type: ActionType.SHOW,
      playerId: action.playerId,
      cardIndices: action.cardIndices,
      timestamp: action.timestamp!,
    },
    seat: player.seat,
    resultingPot: state.pots.reduce((sum, pot) => sum + pot.amount, 0),
    resultingStack: player.stack,
    street: state.street,
  };

  return {
    ...state,
    players: newPlayers,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };
}

/**
 * Handle MUCK action - player hides their cards at showdown
 */
export function handleMuck(state: GameState, action: MuckAction): GameState {
  // Find player
  const player = state.players.find((p) => p?.id === action.playerId);
  if (!player) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }

  // Can only muck at showdown
  if (state.street !== Street.SHOWDOWN) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_ACTION,
      `Can only muck cards at showdown (current street: ${state.street})`,
      { playerId: action.playerId, street: state.street }
    );
  }

  // Player must not have folded
  if (player.status === PlayerStatus.FOLDED) {
    throw new IllegalActionError(ErrorCodes.INVALID_ACTION, `Cannot muck cards after folding`, {
      playerId: action.playerId,
      status: player.status,
    });
  }

  // Cannot muck if you're a winner (winners must show)
  const isWinner = state.winners?.some((w) => w.seat === player.seat);
  if (isWinner) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_ACTION,
      `Winners cannot muck - cards must be shown`,
      { playerId: action.playerId }
    );
  }

  // Set shown cards to null (mucked) - hand is preserved in player.hand
  const newPlayers = [...state.players];
  newPlayers[player.seat] = {
    ...player,
    shownCards: null, // Muck cards (hide them, but preserve hand data)
  };

  const actionRecord: ActionRecord = {
    action: {
      type: ActionType.MUCK,
      playerId: action.playerId,
      timestamp: action.timestamp!,
    },
    seat: player.seat,
    resultingPot: state.pots.reduce((sum, pot) => sum + pot.amount, 0),
    resultingStack: player.stack,
    street: state.street,
  };

  return {
    ...state,
    players: newPlayers,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };
}
