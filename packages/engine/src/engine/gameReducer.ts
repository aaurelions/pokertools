import { GameState, Action, ActionType } from "@pokertools/types";
import { validateAction } from "../actions/validation";
import { handleDeal } from "../actions/dealing";
import { handleFold, handleCheck, handleCall, handleBet, handleRaise } from "../actions/betting";
import { handleSit, handleStand } from "../actions/management";
import { handleShow, handleMuck } from "../actions/showdownActions";
import { handleNextBlindLevel } from "../actions/tournament";
import { handleTimeout, handleTimeBank } from "../actions/special";
import { progressStreet, shouldProgressStreet } from "../actions/streetProgression";
import { recalculatePots } from "../rules/sidePots";
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
  // Validate action
  validateAction(state, action);

  // Apply action based on type
  let newState: GameState;

  switch (action.type) {
    // Management actions
    case ActionType.SIT:
      newState = handleSit(state, action);
      break;

    case ActionType.STAND:
      newState = handleStand(state, action);
      break;

    // Dealing
    case ActionType.DEAL:
      newState = handleDeal(state, action);
      break;

    // Betting actions
    case ActionType.FOLD:
      newState = handleFold(state, action);
      break;

    case ActionType.CHECK:
      newState = handleCheck(state, action);
      break;

    case ActionType.CALL:
      newState = handleCall(state, action);
      break;

    case ActionType.BET:
      // Auto-convert BET to appropriate action if there's already a bet
      // This handles UI implementations that don't distinguish between BET/CALL/RAISE buttons
      // Note: action.amount is the TOTAL bet size, not the amount to add
      const currentBet = Math.max(...Array.from(state.currentBets.values()), 0);
      if (currentBet > 0 && "amount" in action) {
        if (action.amount === currentBet) {
          // Amount equals current bet -> Convert to CALL
          const callAction: Action = {
            type: ActionType.CALL,
            playerId: action.playerId,
            timestamp: action.timestamp,
          };
          newState = handleCall(state, callAction);
        } else if (action.amount > currentBet) {
          // Amount exceeds current bet -> Convert to RAISE
          const raiseAction: Action = {
            type: ActionType.RAISE,
            playerId: action.playerId,
            amount: action.amount,
            timestamp: action.timestamp,
          };
          newState = handleRaise(state, raiseAction);
        } else {
          // Amount is less than current bet -> Keep as BET (will fail validation)
          newState = handleBet(state, action);
        }
      } else {
        newState = handleBet(state, action);
      }
      break;

    case ActionType.RAISE:
      newState = handleRaise(state, action);
      break;

    // Showdown actions
    case ActionType.SHOW:
      newState = handleShow(state, action);
      break;

    case ActionType.MUCK:
      newState = handleMuck(state, action);
      break;

    // Special actions
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
      // Unknown action type
      newState = state;
      break;
  }

  // Check if we should progress to next street
  if (shouldProgressStreet(newState)) {
    // Recalculate pots before progressing
    newState = recalculatePots(newState);
    newState = progressStreet(newState);
  }

  // Check if we should go to showdown
  if (shouldShowdown(newState)) {
    newState = {
      ...newState,
      street: newState.street, // Keep current street for showdown
    };
    newState = determineWinners(newState);
  }

  // Audit chip conservation (throws on failure)
  // Enabled by default, can be disabled via config (not recommended for production)
  if (newState.config.validateIntegrity !== false) {
    validateGameStateIntegrity(newState);
  }

  // Add to previous states for undo
  const previousStates = [...newState.previousStates, state].slice(-MAX_UNDO_HISTORY);

  return {
    ...newState,
    previousStates,
  };
}
