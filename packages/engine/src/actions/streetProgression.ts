import { GameState, Street, PlayerStatus } from "@pokertools/types";
import { burnAndDeal } from "../utils/deck";
import { cardCodesToStrings } from "../utils/cardUtils";
import { getFirstToAct, isActionComplete } from "../rules/actionOrder";

/**
 * Progress to next street
 * - Collects bets into pots
 * - Deals community cards
 * - Resets action
 */
export function progressStreet(state: GameState): GameState {
  // Determine next street
  const nextStreet = getNextStreet(state.street);

  if (nextStreet === null) {
    // Already at showdown or beyond
    return state;
  }

  // Check if we should auto-runout (all remaining players all-in)
  const shouldAutoRunout = checkAutoRunout(state);

  if (shouldAutoRunout) {
    return handleAutoRunout(state);
  }

  // Deal community cards
  const { board, deck } = dealCommunityCards(state, nextStreet);

  // Reset for new street
  // Note: Pots are calculated by recalculatePots() before progressStreet() is called
  const newState: GameState = {
    ...state,
    street: nextStreet,
    board,
    deck,
    pots: state.pots, // Keep existing pots (already updated by recalculatePots)
    currentBets: new Map(),
    lastAggressorSeat: null,
    // Keep timestamp from last action (street progression is not a user action)
  };

  // Set first to act
  const firstToAct = getFirstToAct(newState);

  return {
    ...newState,
    actionTo: firstToAct,
  };
}

/**
 * Get next street in sequence
 * Uses exhaustive mapping for type safety
 */
function getNextStreet(current: Street): Street | null {
  const nextStreetMap: Record<Street, Street | null> = {
    [Street.PREFLOP]: Street.FLOP,
    [Street.FLOP]: Street.TURN,
    [Street.TURN]: Street.RIVER,
    [Street.RIVER]: Street.SHOWDOWN,
    [Street.SHOWDOWN]: null,
  };

  return nextStreetMap[current];
}

/**
 * Deal community cards for the given street
 */
function dealCommunityCards(state: GameState, street: Street): { board: string[]; deck: number[] } {
  const currentBoard: string[] = [...state.board];
  const deck: number[] = [...state.deck];

  switch (street) {
    case Street.FLOP:
      // Burn 1, deal 3
      const [flopCards, flopDeck] = burnAndDeal(deck, 3);
      return {
        board: [...currentBoard, ...cardCodesToStrings(flopCards)],
        deck: flopDeck,
      };

    case Street.TURN:
      // Burn 1, deal 1
      const [turnCards, turnDeck] = burnAndDeal(deck, 1);
      return {
        board: [...currentBoard, ...cardCodesToStrings(turnCards)],
        deck: turnDeck,
      };

    case Street.RIVER:
      // Burn 1, deal 1
      const [riverCards, riverDeck] = burnAndDeal(deck, 1);
      return {
        board: [...currentBoard, ...cardCodesToStrings(riverCards)],
        deck: riverDeck,
      };

    default:
      return { board: currentBoard, deck };
  }
}

/**
 * Check if all remaining players are all-in (auto-runout condition)
 */
function checkAutoRunout(state: GameState): boolean {
  let activeCount = 0;
  let allInCount = 0;

  for (const player of state.players) {
    if (!player) continue;

    if (player.status === PlayerStatus.ACTIVE && player.stack > 0) {
      activeCount++;
    } else if (player.status === PlayerStatus.ALL_IN) {
      allInCount++;
    }
  }

  // Auto-runout if ≤1 active player with chips (rest are all-in or folded)
  return activeCount <= 1 && allInCount > 0;
}

/**
 * Handle auto-runout: deal all remaining streets at once
 * This manually deals cards without calling progressStreet to avoid infinite recursion
 */
function handleAutoRunout(state: GameState): GameState {
  let currentState = state;
  let currentStreet = state.street;

  // Deal remaining streets manually (FLOP -> TURN -> RIVER)
  while (currentStreet !== Street.RIVER) {
    const nextStreet = getNextStreet(currentStreet);
    if (nextStreet === null || nextStreet === Street.SHOWDOWN) break;

    // Deal community cards for this street
    const { board, deck } = dealCommunityCards(currentState, nextStreet);

    // Update state with new street and board
    currentState = {
      ...currentState,
      street: nextStreet,
      board,
      deck,
      currentBets: new Map(), // Clear bets between streets
      lastAggressorSeat: null,
    };

    currentStreet = nextStreet;
  }

  // Move to showdown
  return {
    ...currentState,
    street: Street.SHOWDOWN,
    actionTo: null,
  };
}

/**
 * Check if we should progress to next street
 * (All players have acted and matched bets)
 */
export function shouldProgressStreet(state: GameState): boolean {
  if (state.actionTo !== null) {
    return false; // Action still in progress
  }

  if (state.street === Street.SHOWDOWN) {
    return false; // Already at showdown
  }

  // Check if all active players have acted
  return isActionComplete(state);
}
