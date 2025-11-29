import {
  GameState,
  Street,
  FoldAction,
  CheckAction,
  CallAction,
  BetAction,
  RaiseAction,
  ActionRecord,
  ActionType,
  PlayerStatus,
  Winner,
} from "@pokertools/types";
import { getPlayerById } from "../utils/positioning";
import { getNextToAct } from "../rules/actionOrder";
import { CriticalStateError } from "../errors/CriticalStateError";
import { calculateRake } from "../utils/rake";

/**
 * Handle FOLD action
 */
export function handleFold(state: GameState, action: FoldAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state; // Should have been caught by validation
  }

  const { seat } = result;
  const newPlayers = [...state.players];

  // Set player status to FOLDED
  newPlayers[seat] = {
    ...newPlayers[seat]!,
    status: PlayerStatus.FOLDED,
  };

  // Remove from active players
  const newActivePlayers = state.activePlayers.filter((s) => s !== seat);

  // Add to action history
  const actionRecord: ActionRecord = {
    action,
    seat,
    resultingPot: getTotalPot(state),
    resultingStack: newPlayers[seat].stack,
    street: state.street,
  };

  const currentState: GameState = {
    ...state,
    players: newPlayers,
    activePlayers: newActivePlayers,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };

  // Check if only one player with a live hand remains
  // Count players who have not folded (Active + All-In)
  const playersWithLiveHands = currentState.players.filter(
    (p) => p && p.status !== PlayerStatus.FOLDED
  );

  // Only end the hand if exactly one player has cards
  if (playersWithLiveHands.length === 1 && playersWithLiveHands[0]) {
    // Award remaining pots to last player with live hand
    return awardPotToLastPlayer(currentState, playersWithLiveHands[0].seat);
  }

  // If we have 1 Active player but multiple Live players (others are All-In),
  // the game should naturally progress to Showdown via progressStreet/checkAutoRunout

  // Move to next player
  const nextToAct = getNextToAct(currentState);

  return {
    ...currentState,
    actionTo: nextToAct,
  };
}

/**
 * Handle CHECK action
 */
export function handleCheck(state: GameState, action: CheckAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  const { seat } = result;

  // Add to action history
  const actionRecord: ActionRecord = {
    action,
    seat,
    resultingPot: getTotalPot(state),
    resultingStack: state.players[seat]!.stack,
    street: state.street,
  };

  const newState: GameState = {
    ...state,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };

  // Move to next player
  const nextToAct = getNextToAct(newState);

  return {
    ...newState,
    actionTo: nextToAct,
  };
}

/**
 * Handle CALL action
 */
export function handleCall(state: GameState, action: CallAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  const { player, seat } = result;

  // Calculate amount to call
  const currentBet = getCurrentBet(state);
  const playerBet = state.currentBets.get(seat) ?? 0;
  const toCall = currentBet - playerBet;

  // Determine actual call amount (may be all-in)
  const callAmount = Math.min(toCall, player.stack);
  const isAllIn = callAmount === player.stack;

  // Update player
  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    stack: player.stack - callAmount,
    betThisStreet: playerBet + callAmount,
    totalInvestedThisHand: player.totalInvestedThisHand + callAmount,
    status: isAllIn ? PlayerStatus.ALL_IN : PlayerStatus.ACTIVE,
  };

  // Update current bets
  const newCurrentBets = new Map(state.currentBets);
  newCurrentBets.set(seat, playerBet + callAmount);

  // Add to action history
  const actionRecord: ActionRecord = {
    action,
    seat,
    resultingPot: getTotalPot(state) + callAmount,
    resultingStack: newPlayers[seat].stack,
    street: state.street,
  };

  const newState: GameState = {
    ...state,
    players: newPlayers,
    currentBets: newCurrentBets,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };

  // Move to next player
  const nextToAct = getNextToAct(newState);

  return {
    ...newState,
    actionTo: nextToAct,
  };
}

/**
 * Handle BET action
 */
export function handleBet(state: GameState, action: BetAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  const { player, seat } = result;
  const betAmount = Math.min(action.amount, player.stack);
  const isAllIn = betAmount === player.stack;

  // Update player
  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    stack: player.stack - betAmount,
    betThisStreet: betAmount,
    totalInvestedThisHand: player.totalInvestedThisHand + betAmount,
    status: isAllIn ? PlayerStatus.ALL_IN : PlayerStatus.ACTIVE,
  };

  // Update current bets
  const newCurrentBets = new Map(state.currentBets);
  newCurrentBets.set(seat, betAmount);

  // Add to action history
  const actionRecord: ActionRecord = {
    action,
    seat,
    resultingPot: getTotalPot(state) + betAmount,
    resultingStack: newPlayers[seat].stack,
    street: state.street,
  };

  const newState: GameState = {
    ...state,
    players: newPlayers,
    currentBets: newCurrentBets,
    minRaise: betAmount + betAmount, // Min raise is current bet + raise increment
    lastRaiseAmount: betAmount,
    lastAggressorSeat: seat,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };

  // Move to next player
  const nextToAct = getNextToAct(newState);

  return {
    ...newState,
    actionTo: nextToAct,
  };
}

/**
 * Handle RAISE action
 */
export function handleRaise(state: GameState, action: RaiseAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  const { player, seat } = result;
  const currentBet = getCurrentBet(state);
  const playerBet = state.currentBets.get(seat) ?? 0;

  const raiseAmount = Math.min(action.amount, playerBet + player.stack);
  const addedChips = raiseAmount - playerBet;
  const isAllIn = addedChips === player.stack;

  // Calculate raise increment
  const raiseIncrement = raiseAmount - currentBet;

  // Update player
  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    stack: player.stack - addedChips,
    betThisStreet: raiseAmount,
    totalInvestedThisHand: player.totalInvestedThisHand + addedChips,
    status: isAllIn ? PlayerStatus.ALL_IN : PlayerStatus.ACTIVE,
  };

  // Update current bets
  const newCurrentBets = new Map(state.currentBets);
  newCurrentBets.set(seat, raiseAmount);

  // Add to action history
  const actionRecord: ActionRecord = {
    action,
    seat,
    resultingPot: getTotalPot(state) + addedChips,
    resultingStack: newPlayers[seat].stack,
    street: state.street,
  };

  // Determine if this reopens betting (incomplete raise rule)
  const reopensBetting = raiseIncrement >= state.lastRaiseAmount;

  // Min-raise calculation:
  // - If reopens betting: new currentBet + new increment
  // - If incomplete raise: new currentBet + old increment (TDA/WSOP rule)
  //   Example: P1 bets 100, P2 all-in 120, P3 must raise to 120+100=220 minimum
  const newMinRaise = reopensBetting
    ? raiseAmount + raiseIncrement
    : raiseAmount + state.lastRaiseAmount;

  const newState: GameState = {
    ...state,
    players: newPlayers,
    currentBets: newCurrentBets,
    minRaise: newMinRaise,
    lastRaiseAmount: reopensBetting ? raiseIncrement : state.lastRaiseAmount,
    lastAggressorSeat: reopensBetting ? seat : state.lastAggressorSeat,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };

  // Move to next player
  const nextToAct = getNextToAct(newState);

  return {
    ...newState,
    actionTo: nextToAct,
  };
}

/**
 * Get current highest bet
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

/**
 * Get total pot size
 */
function getTotalPot(state: GameState): number {
  let total = 0;
  for (const pot of state.pots) {
    total += pot.amount;
  }
  for (const bet of state.currentBets.values()) {
    total += bet;
  }
  return total;
}

/**
 * Award pots to remaining eligible players when hand ends by folds
 * Properly handles side pot eligibility and uncontested pots
 */
function awardPotToLastPlayer(state: GameState, winningSeat: number): GameState {
  const newPlayers = [...state.players];
  const winners: Winner[] = [];

  // Process each pot separately, checking eligibility
  let totalRakeFromPots = 0;

  for (const pot of state.pots) {
    // Find all non-folded players eligible for this pot
    const eligibleNonFolded = pot.eligibleSeats.filter((seat) => {
      const player = state.players[seat];
      return player && player.status !== PlayerStatus.FOLDED;
    });

    // Calculate rake for this pot - GLOBAL cap applied across all pots
    const { rake: potRake } = calculateRake(state, pot.amount, totalRakeFromPots);
    totalRakeFromPots += potRake;
    const potAfterRake = pot.amount - potRake;

    if (eligibleNonFolded.length === 0) {
      // No eligible players remain - should not happen, but defensive
      // Award to last player to fold from eligible seats (fallback)
      const lastEligible = pot.eligibleSeats[pot.eligibleSeats.length - 1];
      const player = newPlayers[lastEligible];
      if (player) {
        newPlayers[lastEligible] = {
          ...player,
          stack: player.stack + potAfterRake,
        };
        winners.push({
          seat: lastEligible,
          amount: potAfterRake,
          hand: null,
          handRank: null,
        });
      }
    } else if (eligibleNonFolded.length === 1) {
      // Exactly one eligible player - they win this pot
      const winnerSeat = eligibleNonFolded[0];
      const player = newPlayers[winnerSeat]!;
      newPlayers[winnerSeat] = {
        ...player,
        stack: player.stack + potAfterRake,
      };
      winners.push({
        seat: winnerSeat,
        amount: potAfterRake,
        hand: null,
        handRank: null,
      });
    } else {
      // Multiple eligible players remain - this means awardPotToLastPlayer was called incorrectly
      // The hand should have gone to showdown instead
      throw new CriticalStateError(
        "awardPotToLastPlayer called with multiple eligible players remaining",
        {
          potAmount: pot.amount,
          eligibleSeats: pot.eligibleSeats,
          eligibleNonFolded,
          winningSeat,
        }
      );
    }
  }

  // Award current bets to last active player
  // Note: We need to subtract the winner's own bet since that's just a refund, not winnings
  let currentBetsTotal = 0;
  for (const bet of state.currentBets.values()) {
    currentBetsTotal += bet;
  }

  const newActionHistory = [...state.actionHistory];
  let totalRake = 0;

  if (currentBetsTotal > 0) {
    const player = newPlayers[winningSeat]!;
    const winnersBet = state.currentBets.get(winningSeat) ?? 0;

    // Calculate rake on the pot (before awarding) - GLOBAL cap applied
    const { rake } = calculateRake(state, currentBetsTotal, totalRakeFromPots);
    totalRake = totalRakeFromPots + rake;
    const potAfterRake = currentBetsTotal - rake;

    // Award the pot after rake deduction
    newPlayers[winningSeat] = {
      ...player,
      stack: player.stack + potAfterRake,
    };

    // Record uncalled bet refund if winner had a bet
    if (winnersBet > 0) {
      const uncalledBetAction: ActionRecord = {
        action: {
          type: ActionType.UNCALLED_BET_RETURNED,
          playerId: player.id,
          amount: winnersBet,
          timestamp: state.timestamp,
        },
        seat: winningSeat,
        resultingPot: 0, // Pot will be empty after this
        resultingStack: player.stack + winnersBet,
        street: state.street,
      };
      newActionHistory.push(uncalledBetAction);
    }

    // Record only the actual winnings (opponents' bets, not their own bet refund, after rake)
    // Winnings = potAfterRake - winnersBet (refund doesn't count as winnings)
    const actualWinnings = potAfterRake - winnersBet;

    if (actualWinnings > 0) {
      // Add to winners if not already there, or update amount
      const existingIndex = winners.findIndex((w) => w.seat === winningSeat);
      if (existingIndex >= 0) {
        // Update existing winner's amount
        winners[existingIndex] = {
          ...winners[existingIndex],
          amount: winners[existingIndex].amount + actualWinnings,
        };
      } else {
        winners.push({
          seat: winningSeat,
          amount: actualWinnings,
          hand: null,
          handRank: null,
        });
      }
    }
  }

  // NOTE: We do NOT reset totalInvestedThisHand here because it's used by getInitialChips()
  // to calculate total chips in the game. It will be reset when a new hand is dealt.

  return {
    ...state,
    players: newPlayers,
    street: Street.SHOWDOWN, // Mark hand as complete
    pots: [],
    currentBets: new Map(),
    winners,
    actionTo: null,
    actionHistory: newActionHistory,
    rakeThisHand: state.rakeThisHand + totalRake, // totalRake already includes rake from both pots and currentBets
  };
}
