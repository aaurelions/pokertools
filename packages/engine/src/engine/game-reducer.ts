import { GameState, Action, ActionType } from "@pokertools/types";
import { validateAction } from "../actions/validation";
import { handleDeal } from "../actions/dealing";
import { handleFold, handleCheck, handleCall, handleBet, handleRaise } from "../actions/betting";
import { handleSit, handleStand, handleAddChips, handleReserveSeat } from "../actions/management";
import { handleShow, handleMuck } from "../actions/showdown-actions";
import { handleNextBlindLevel } from "../actions/tournament";
import { handleTimeout, handleTimeBank } from "../actions/special";
import { progressStreet, shouldProgressStreet } from "../actions/street-progression";
import { recalculatePots } from "../rules/side-pots";
import { determineWinners, shouldShowdown } from "../rules/showdown";
import { validateGameStateIntegrity } from "../utils/invariants";
import { MAX_UNDO_HISTORY } from "../utils/constants";

/**
 * Pure game reducer: f(state, action) => newState
 * This is the heart of the poker engine
 *
 * @param state Current game state
 * @param action Action to apply
 * @returns New game state
 */
export function gameReducer(state: GameState, action: Action): GameState {
  validateAction(state, action);

  let newState: GameState;

  switch (action.type) {
    case ActionType.SIT:
      newState = handleSit(state, action);
      break;

    case ActionType.STAND:
      newState = handleStand(state, action);
      break;

    case ActionType.ADD_CHIPS:
      newState = handleAddChips(state, action);
      break;

    case ActionType.RESERVE_SEAT:
      newState = handleReserveSeat(state, action);
      break;

    case ActionType.DEAL:
      newState = handleDeal(state, action);
      break;

    case ActionType.FOLD:
      newState = handleFold(state, action);
      break;

    case ActionType.CHECK:
      newState = handleCheck(state, action);
      break;

    case ActionType.CALL:
      newState = handleCall(state, action);
      break;

    // Auto-convert BET to RAISE/CALL when there's already a wager.
    // Note: action.amount is the TOTAL bet, not the increment.
    case ActionType.BET:
      const currentBet = Math.max(...Array.from(state.currentBets.values()), 0);
      if (currentBet > 0 && "amount" in action) {
        if (action.amount === currentBet) {
          const callAction: Action = {
            type: ActionType.CALL,
            playerId: action.playerId,
            timestamp: action.timestamp,
          };
          newState = handleCall(state, callAction);
        } else if (action.amount > currentBet) {
          const raiseAction: Action = {
            type: ActionType.RAISE,
            playerId: action.playerId,
            amount: action.amount,
            timestamp: action.timestamp,
          };
          newState = handleRaise(state, raiseAction);
        } else {
          // amount < currentBet: pass through (will fail validation)
          newState = handleBet(state, action);
        }
      } else {
        newState = handleBet(state, action);
      }
      break;

    case ActionType.RAISE:
      newState = handleRaise(state, action);
      break;

    case ActionType.SHOW:
      newState = handleShow(state, action);
      break;

    case ActionType.MUCK:
      newState = handleMuck(state, action);
      break;

    case ActionType.TIMEOUT:
      newState = handleTimeout(state, action);
      break;

    case ActionType.TIME_BANK:
      newState = handleTimeBank(state, action);
      break;

    case ActionType.NEXT_BLIND_LEVEL:
      newState = handleNextBlindLevel(state, action);
      break;

    default:
      newState = state;
      break;
  }

  // Recalculate pots, then progress street.
  if (shouldProgressStreet(newState)) {
    newState = recalculatePots(newState);
    newState = progressStreet(newState);
  }

  if (shouldShowdown(newState)) {
    newState = determineWinners(newState);
  }

  if (newState.actionTo !== null && newState.players[newState.actionTo]?.isSittingOut) {
    newState = { ...newState, actionTo: null };
  }

  // Integrity check; can be disabled via config (not recommended for production).
  if (newState.config.validateIntegrity !== false) {
    validateGameStateIntegrity(newState);
  }

  const previousStates = [...newState.previousStates, state].slice(-MAX_UNDO_HISTORY);

  return {
    ...newState,
    previousStates,
  };
}
