import { GameState, NextBlindLevelAction, ActionRecord, ActionType } from "@pokertools/types";

/**
 * Handle NEXT_BLIND_LEVEL action - advance to next blind level in tournament
 */
export function handleNextBlindLevel(state: GameState, action: NextBlindLevelAction): GameState {
  // Only applicable for tournaments
  if (!state.config.blindStructure) {
    return state;
  }

  const nextLevel = state.blindLevel + 1;

  // Check if we're at max level
  if (nextLevel >= state.config.blindStructure.length) {
    return state; // At max level, no change
  }

  const blindLevel = state.config.blindStructure[nextLevel];

  // Record action to history
  const actionRecord: ActionRecord = {
    action: {
      type: ActionType.NEXT_BLIND_LEVEL,
      timestamp: action.timestamp!,
    },
    seat: null, // Table-level action
    resultingPot: state.pots.reduce((sum, pot) => sum + pot.amount, 0),
    resultingStack: 0, // Not applicable
    street: state.street,
  };

  return {
    ...state,
    blindLevel: nextLevel,
    smallBlind: blindLevel.smallBlind,
    bigBlind: blindLevel.bigBlind,
    ante: blindLevel.ante,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };
}
