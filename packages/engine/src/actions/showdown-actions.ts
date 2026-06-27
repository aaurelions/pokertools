import {
  GameState,
  ShowAction,
  MuckAction,
  ActionRecord,
  ActionType,
  PlayerStatus,
  Street,
} from "@pokertools/types";
import { IllegalActionError } from "../errors/illegal-action-error";
import { ErrorCodes } from "@pokertools/types";

/**
 * Handle SHOW action - player reveals their cards at showdown
 */
export function handleShow(state: GameState, action: ShowAction): GameState {
  const player = state.players.find((p) => p?.id === action.playerId);
  if (!player) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }

  if (state.street !== Street.SHOWDOWN) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_ACTION,
      `Can only show cards at showdown (current street: ${state.street})`,
      { playerId: action.playerId, street: state.street }
    );
  }

  if (player.status === PlayerStatus.FOLDED) {
    throw new IllegalActionError(ErrorCodes.INVALID_ACTION, `Cannot show cards after folding`, {
      playerId: action.playerId,
      status: player.status,
    });
  }

  if (!player.hand) {
    throw new IllegalActionError(ErrorCodes.INVALID_ACTION, `Player has no cards to show`, {
      playerId: action.playerId,
    });
  }

  let cardIndices: number[];
  if (action.cardIndices && action.cardIndices.length > 0) {
    cardIndices = action.cardIndices.filter((i) => i >= 0 && i < player.hand!.length);
    if (cardIndices.length === 0) return state;
  } else {
    cardIndices = Array.from({ length: player.hand.length }, (_, i) => i);
  }

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
  const player = state.players.find((p) => p?.id === action.playerId);
  if (!player) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }

  if (state.street !== Street.SHOWDOWN) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_ACTION,
      `Can only muck cards at showdown (current street: ${state.street})`,
      { playerId: action.playerId, street: state.street }
    );
  }

  if (player.status === PlayerStatus.FOLDED) {
    throw new IllegalActionError(ErrorCodes.INVALID_ACTION, `Cannot muck cards after folding`, {
      playerId: action.playerId,
      status: player.status,
    });
  }

  const isWinner = state.winners?.some((w) => w.seat === player.seat);
  if (isWinner) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_ACTION,
      `Winners cannot muck - cards must be shown`,
      { playerId: action.playerId }
    );
  }

  const newPlayers = [...state.players];
  newPlayers[player.seat] = {
    ...player,
    shownCards: null,
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
