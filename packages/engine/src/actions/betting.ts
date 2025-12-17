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
    timeBankActiveSeat: null, // Clear time bank flag on any action
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
    timeBankActiveSeat: null, // Clear time bank flag on any action
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

  // Add to action history (include actual call amount in the action)
  const actionRecord: ActionRecord = {
    action: { ...action, amount: callAmount }, // Populate amount field for history
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
    timeBankActiveSeat: null, // Clear time bank flag on any action
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
    timeBankActiveSeat: null, // Clear time bank flag on any action
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
    timeBankActiveSeat: null, // Clear time bank flag on any action
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
 * Properly handles side pot eligibility and uncalled bets
 *
 * Key principle: Uncalled bets are NOT raked and are returned to the bettor immediately.
 * Only the contested portion of the pot (money actually at risk) is subject to rake.
 */
function awardPotToLastPlayer(state: GameState, winningSeat: number): GameState {
  const newPlayers = [...state.players];
  const newActionHistory = [...state.actionHistory];
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

  // Handle current bets with proper uncalled bet logic
  if (state.currentBets.size > 0) {
    const winnersBet = state.currentBets.get(winningSeat) ?? 0;

    // Find the second-highest bet (highest opponent bet)
    // This determines how much of the winner's bet was actually "called"
    let maxOpponentBet = 0;
    for (const [seat, amount] of state.currentBets.entries()) {
      if (seat !== winningSeat && amount > maxOpponentBet) {
        maxOpponentBet = amount;
      }
    }

    // Calculate uncalled and called portions
    let uncalledAmount = 0;
    let calledPortion = 0;

    if (winnersBet > maxOpponentBet) {
      uncalledAmount = winnersBet - maxOpponentBet;
      calledPortion = maxOpponentBet;
    } else {
      calledPortion = winnersBet;
    }

    // Step 1: Return uncalled bet immediately (NO RAKE on uncalled bets)
    if (uncalledAmount > 0) {
      const player = newPlayers[winningSeat]!;
      newPlayers[winningSeat] = {
        ...player,
        stack: player.stack + uncalledAmount,
      };

      // Record the uncalled bet return
      newActionHistory.push({
        action: {
          type: ActionType.UNCALLED_BET_RETURNED,
          playerId: player.id,
          amount: uncalledAmount,
          timestamp: state.timestamp,
        },
        seat: winningSeat,
        resultingPot: getTotalPot(state) - uncalledAmount,
        resultingStack: player.stack + uncalledAmount,
        street: state.street,
      });
    }

    // Step 2: Calculate contested pot (winner's called portion + all opponent bets)
    let contestedPot = calledPortion;
    for (const [seat, amount] of state.currentBets.entries()) {
      if (seat !== winningSeat) {
        contestedPot += amount;
      }
    }

    // Step 3: Rake and award the contested portion only
    if (contestedPot > 0) {
      const { rake } = calculateRake(state, contestedPot, totalRakeFromPots);
      const totalRake = totalRakeFromPots + rake;
      const winnings = contestedPot - rake;

      const player = newPlayers[winningSeat]!;
      newPlayers[winningSeat] = {
        ...player,
        stack: player.stack + winnings,
      };

      // Update winners array
      // Only count actual winnings (contested pot after rake, minus winner's own contribution)
      const actualWinnings = winnings - calledPortion;

      if (actualWinnings > 0) {
        const existingIndex = winners.findIndex((w) => w.seat === winningSeat);
        if (existingIndex >= 0) {
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

      // Update total rake for the hand
      totalRakeFromPots = totalRake;
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
    rakeThisHand: state.rakeThisHand + totalRakeFromPots,
  };
}
