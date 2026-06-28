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
import { getNextToAct } from "../rules/action-order";
import { CriticalStateError } from "../errors/critical-state-error";
import { calculateRake } from "../utils/rake";

/**
 * Handle FOLD action
 */
export function handleFold(state: GameState, action: FoldAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  const { seat } = result;
  const newPlayers = [...state.players];

  newPlayers[seat] = {
    ...newPlayers[seat]!,
    status: PlayerStatus.FOLDED,
  };

  const newActivePlayers = state.activePlayers.filter((s) => s !== seat);

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
    timeBankActiveSeat: null,
    timestamp: action.timestamp!,
  };

  const playersWithLiveHands = currentState.players.filter(
    (p) => p && p.status !== PlayerStatus.FOLDED
  );

  if (playersWithLiveHands.length === 1 && playersWithLiveHands[0]) {
    return awardPotToLastPlayer(currentState, playersWithLiveHands[0].seat);
  }

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

  const currentBet = getCurrentBet(state);
  const playerBet = state.currentBets.get(seat) ?? 0;
  const toCall = currentBet - playerBet;

  const callAmount = Math.min(toCall, player.stack);
  const isAllIn = callAmount === player.stack;

  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    stack: player.stack - callAmount,
    betThisStreet: playerBet + callAmount,
    totalInvestedThisHand: player.totalInvestedThisHand + callAmount,
    status: isAllIn ? PlayerStatus.ALL_IN : PlayerStatus.ACTIVE,
  };

  const newCurrentBets = new Map(state.currentBets);
  newCurrentBets.set(seat, playerBet + callAmount);

  const actionRecord: ActionRecord = {
    action: { ...action, amount: callAmount },
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

  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    stack: player.stack - betAmount,
    betThisStreet: betAmount,
    totalInvestedThisHand: player.totalInvestedThisHand + betAmount,
    status: isAllIn ? PlayerStatus.ALL_IN : PlayerStatus.ACTIVE,
  };

  const newCurrentBets = new Map(state.currentBets);
  newCurrentBets.set(seat, betAmount);

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
    minRaise: betAmount + betAmount,
    lastRaiseAmount: betAmount,
    lastAggressorSeat: seat,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };

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

  const raiseIncrement = raiseAmount - currentBet;

  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    stack: player.stack - addedChips,
    betThisStreet: raiseAmount,
    totalInvestedThisHand: player.totalInvestedThisHand + addedChips,
    status: isAllIn ? PlayerStatus.ALL_IN : PlayerStatus.ACTIVE,
  };

  const newCurrentBets = new Map(state.currentBets);
  newCurrentBets.set(seat, raiseAmount);

  const actionRecord: ActionRecord = {
    action,
    seat,
    resultingPot: getTotalPot(state) + addedChips,
    resultingStack: newPlayers[seat].stack,
    street: state.street,
  };

  // Incomplete-raise rule: does this raise reopen the betting?
  const reopensBetting = raiseIncrement >= state.lastRaiseAmount;

  // Incomplete all-in raises do not change the next minimum full raise.
  const newMinRaise = reopensBetting ? raiseAmount + raiseIncrement : state.minRaise;

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
 * Award pots to remaining eligible players when hand ends by folds.
 *
 * Key principle: Uncalled bets are NOT raked and are returned to the bettor immediately.
 * Only the contested portion is subject to rake.
 */
function awardPotToLastPlayer(state: GameState, winningSeat: number): GameState {
  const newPlayers = [...state.players];
  const newActionHistory = [...state.actionHistory];
  const winners: Winner[] = [];
  let totalRakeFromPots = 0;

  for (const pot of state.pots) {
    const eligibleNonFolded = pot.eligibleSeats.filter((seat) => {
      const player = state.players[seat];
      return player && player.status !== PlayerStatus.FOLDED;
    });

    const { rake: potRake } = calculateRake(state, pot.amount, totalRakeFromPots);
    totalRakeFromPots += potRake;
    const potAfterRake = pot.amount - potRake;

    if (eligibleNonFolded.length === 0) {
      // Defensive fallback: no eligible players remain.
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

  // Uncalled bet logic: three-step process.
  if (state.currentBets.size > 0) {
    const winnersBet = state.currentBets.get(winningSeat) ?? 0;

    // Second-highest bet determines how much of winner's bet was actually "called".
    let maxOpponentBet = 0;
    for (const [seat, amount] of state.currentBets.entries()) {
      if (seat !== winningSeat && amount > maxOpponentBet) {
        maxOpponentBet = amount;
      }
    }

    const uncalledAmount = winnersBet > maxOpponentBet ? winnersBet - maxOpponentBet : 0;
    const calledPortion = winnersBet > maxOpponentBet ? maxOpponentBet : winnersBet;

    // Step 1: Return uncalled bet immediately (NO RAKE on uncalled bets).
    if (uncalledAmount > 0) {
      const player = newPlayers[winningSeat]!;
      newPlayers[winningSeat] = {
        ...player,
        stack: player.stack + uncalledAmount,
      };

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

    // Step 2: Contested pot = winner's called portion + all opponent bets.
    let contestedPot = calledPortion;
    for (const [seat, amount] of state.currentBets.entries()) {
      if (seat !== winningSeat) {
        contestedPot += amount;
      }
    }

    // Step 3: Rake and award the contested portion only.
    if (contestedPot > 0) {
      const { rake } = calculateRake(state, contestedPot, totalRakeFromPots);
      const totalRake = totalRakeFromPots + rake;
      const winnings = contestedPot - rake;

      const player = newPlayers[winningSeat]!;
      newPlayers[winningSeat] = {
        ...player,
        stack: player.stack + winnings,
      };

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

      totalRakeFromPots = totalRake;
    }
  }

  return {
    ...state,
    players: newPlayers,
    street: Street.SHOWDOWN,
    pots: [],
    currentBets: new Map(),
    winners,
    actionTo: null,
    actionHistory: newActionHistory,
    rakeThisHand: state.rakeThisHand + totalRakeFromPots,
  };
}
