import {
  GameState,
  Street,
  Action,
  ActionType,
  PlayerStatus,
  SitAction,
  StandAction,
  TimeoutAction,
  TimeBankAction,
  AddChipsAction,
  ReserveSeatAction,
} from "@pokertools/types";
import { IllegalActionError } from "../errors/IllegalActionError";
import { ErrorCodes } from "../errors/ErrorCodes";
import { getPlayerById } from "../utils/positioning";

/**
 * Validate that an action is legal in the current game state
 * Throws IllegalActionError if action is invalid
 */
export function validateAction(state: GameState, action: Action): void {
  // Type-specific validation
  switch (action.type) {
    case ActionType.FOLD:
    case ActionType.CHECK:
    case ActionType.CALL:
    case ActionType.BET:
    case ActionType.RAISE:
      validateBettingAction(state, action);
      break;

    case ActionType.DEAL:
      validateDealAction(state);
      break;

    case ActionType.SIT:
      validateSitAction(state, action);
      break;

    case ActionType.STAND:
      validateStandAction(state, action);
      break;

    case ActionType.TIMEOUT:
    case ActionType.TIME_BANK:
      validateTimeAction(state, action);
      break;

    case ActionType.ADD_CHIPS:
      validateAddChipsAction(state, action);
      break;

    case ActionType.RESERVE_SEAT:
      validateReserveSeatAction(state, action);
      break;

    default:
      // Other actions don't need validation
      break;
  }
}

function validateBettingAction(state: GameState, action: Action): void {
  if (!("playerId" in action)) {
    throw new IllegalActionError(ErrorCodes.INVALID_ACTION, "Action missing playerId");
  }

  const result = getPlayerById(state, action.playerId);

  if (!result) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }

  const { player, seat } = result;

  // Check if it's player's turn
  if (state.actionTo !== seat) {
    throw new IllegalActionError(
      ErrorCodes.NOT_YOUR_TURN,
      `Player ${action.playerId} attempted to act, but action is on seat ${state.actionTo}`,
      {
        playerId: action.playerId,
        playerSeat: seat,
        actionTo: state.actionTo,
        street: state.street,
      }
    );
  }

  // Check player status
  if (player.status !== PlayerStatus.ACTIVE) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_ACTIVE,
      `Player ${action.playerId} cannot act with status ${player.status}`,
      { playerId: action.playerId, status: player.status }
    );
  }

  // Check player has chips
  if (player.stack === 0 && action.type !== ActionType.FOLD) {
    throw new IllegalActionError(ErrorCodes.NO_CHIPS, `Player ${action.playerId} has no chips`, {
      playerId: action.playerId,
    });
  }

  // Action-specific validation
  const currentBet = getCurrentBet(state);
  const playerBet = state.currentBets.get(seat) ?? 0;
  const toCall = currentBet - playerBet;

  switch (action.type) {
    case ActionType.CHECK:
      if (toCall > 0) {
        throw new IllegalActionError(
          ErrorCodes.CANNOT_CHECK,
          `Player ${action.playerId} cannot check with ${toCall} to call`,
          { playerId: action.playerId, toCall }
        );
      }
      break;

    case ActionType.CALL:
      if (toCall === 0) {
        throw new IllegalActionError(
          ErrorCodes.NOTHING_TO_CALL,
          `Player ${action.playerId} has nothing to call`,
          { playerId: action.playerId }
        );
      }
      break;

    case ActionType.BET:
      // Note: We allow BET even when currentBet > 0 because the reducer will auto-convert it to RAISE or CALL
      // This handles UI implementations that don't distinguish between BET and RAISE buttons
      if ("amount" in action) {
        // Reject bets below the current bet (string bet exploit)
        if (currentBet > 0 && action.amount < currentBet) {
          throw new IllegalActionError(
            ErrorCodes.BET_TOO_SMALL,
            `Bet of ${action.amount} is below current bet ${currentBet}`,
            { amount: action.amount, currentBet }
          );
        }
        // Reject bets below big blind (when no current bet)
        if (action.amount < state.bigBlind && action.amount < player.stack) {
          throw new IllegalActionError(
            ErrorCodes.BET_TOO_SMALL,
            `Bet of ${action.amount} is below minimum ${state.bigBlind}`,
            { amount: action.amount, minimum: state.bigBlind }
          );
        }
      }
      break;

    case ActionType.RAISE:
      // If the current player is still marked as the last aggressor, it means
      // intermediate actions (like calls or incomplete all-in raises) did NOT
      // reopen the betting. Therefore, they cannot re-raise their own bet.
      if (state.lastAggressorSeat === seat) {
        throw new IllegalActionError(
          ErrorCodes.CANNOT_RERAISE,
          "Betting has not been re-opened to you (incomplete raise or no action)",
          {
            playerId: action.playerId,
            seat,
            lastAggressor: state.lastAggressorSeat,
          }
        );
      }

      if (currentBet === 0) {
        throw new IllegalActionError(
          ErrorCodes.CANNOT_RAISE,
          `Player ${action.playerId} cannot raise when there's no bet`,
          { playerId: action.playerId }
        );
      }
      if ("amount" in action) {
        // Check if player is going all-in (incomplete raise exception)
        const isAllIn = action.amount >= playerBet + player.stack;

        // Reject raises that don't exceed current bet (unless all-in)
        if (action.amount <= currentBet && !isAllIn) {
          throw new IllegalActionError(
            ErrorCodes.RAISE_TOO_SMALL,
            `Raise to ${action.amount} must be greater than current bet ${currentBet}`,
            { amount: action.amount, currentBet }
          );
        }

        // Check minimum raise requirement (unless player is going all-in)
        const raiseIncrement = action.amount - currentBet;

        if (!isAllIn && action.amount < state.minRaise) {
          throw new IllegalActionError(
            ErrorCodes.RAISE_TOO_SMALL,
            `Raise to ${action.amount} is below minimum ${state.minRaise}`,
            {
              amount: action.amount,
              currentBet,
              raiseIncrement,
              minRaise: state.minRaise,
            }
          );
        }
      }
      break;
  }
}

function validateDealAction(state: GameState): void {
  if (state.street !== Street.PREFLOP || state.handNumber > 0) {
    // Allow dealing if we're at showdown (hand complete) or haven't started
    if (state.street !== Street.SHOWDOWN && state.handNumber > 0) {
      throw new IllegalActionError(
        ErrorCodes.CANNOT_DEAL,
        "Cannot deal while hand is in progress",
        { street: state.street }
      );
    }
  }

  // Check we have enough players
  const activePlayers = state.players.filter((p) => p && p.stack > 0 && !p.isSittingOut);

  if (activePlayers.length < 2) {
    throw new IllegalActionError(
      ErrorCodes.NOT_ENOUGH_PLAYERS,
      `Need at least 2 players to deal, found ${activePlayers.length}`,
      { playerCount: activePlayers.length }
    );
  }
}

function validateSitAction(state: GameState, action: SitAction): void {
  if (action.seat < 0 || action.seat >= state.maxPlayers) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_SEAT,
      `Seat ${action.seat} is invalid (max: ${state.maxPlayers - 1})`,
      { seat: action.seat, maxPlayers: state.maxPlayers }
    );
  }

  const existingPlayer = state.players[action.seat];

  if (existingPlayer !== null) {
    // Allow claiming the seat if it is RESERVED by THIS player
    const isMyReservation =
      existingPlayer.status === PlayerStatus.RESERVED && existingPlayer.id === action.playerId;

    if (!isMyReservation) {
      throw new IllegalActionError(
        ErrorCodes.SEAT_OCCUPIED,
        `Seat ${action.seat} is already occupied`,
        { seat: action.seat }
      );
    }
  }

  if (action.stack <= 0) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_STACK,
      `Stack must be positive, got ${action.stack}`,
      { stack: action.stack }
    );
  }
}

function validateStandAction(state: GameState, action: StandAction): void {
  const result = getPlayerById(state, action.playerId);

  if (!result) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }
}

function validateTimeAction(state: GameState, action: TimeoutAction | TimeBankAction): void {
  const result = getPlayerById(state, action.playerId);

  if (!result) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }

  const { seat } = result;

  if (state.actionTo !== seat) {
    throw new IllegalActionError(
      ErrorCodes.NOT_YOUR_TURN,
      `Player ${action.playerId} cannot use time action when it's not their turn`,
      { playerId: action.playerId, actionTo: state.actionTo }
    );
  }
}

function validateAddChipsAction(state: GameState, action: AddChipsAction): void {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    throw new IllegalActionError(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player ${action.playerId} not found`,
      { playerId: action.playerId }
    );
  }
}

function validateReserveSeatAction(state: GameState, action: ReserveSeatAction): void {
  if (action.seat < 0 || action.seat >= state.maxPlayers) {
    throw new IllegalActionError(
      ErrorCodes.INVALID_SEAT,
      `Seat ${action.seat} is invalid (max: ${state.maxPlayers - 1})`,
      { seat: action.seat, maxPlayers: state.maxPlayers }
    );
  }

  if (state.players[action.seat] !== null) {
    throw new IllegalActionError(
      ErrorCodes.SEAT_OCCUPIED,
      `Seat ${action.seat} is already occupied`,
      { seat: action.seat }
    );
  }
}

/**
 * Get current highest bet this street
 */
function getCurrentBet(state: GameState): number {
  let maxBet = 0;
  for (const bet of state.currentBets.values()) {
    if (bet > maxBet) {
      maxBet = bet;
    }
  }
  return maxBet;
}
