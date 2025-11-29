import { GameState, Pot, PlayerStatus, ActionType, ActionRecord } from "@pokertools/types";
import { CriticalStateError } from "../errors/CriticalStateError";

/**
 * Investment record for side pot calculation
 */
interface Investment {
  seat: number;
  amount: number;
  folded: boolean;
}

/**
 * Calculate side pots using iterative subtraction method
 *
 * Algorithm:
 * 1. Combine all player investments (bets + total invested)
 * 2. Sort by investment amount (ascending)
 * 3. For each player from smallest to largest:
 *    - Create pot = (player investment - previous) × remaining players
 *    - Add player + all higher investors to eligible list
 * 4. Return pots array (main + sides)
 *
 * @param state Current game state
 * @returns Array of pots (main pot first, then side pots)
 */
export function calculateSidePots(state: GameState): Pot[] {
  // Collect all investments (including folded players - their chips stay in the pot)
  const investments: Investment[] = [];

  for (let seat = 0; seat < state.players.length; seat++) {
    const player = state.players[seat];
    if (!player) continue;

    // totalInvestedThisHand already includes all bets (current and previous streets)
    const totalInvestment = player.totalInvestedThisHand;

    if (totalInvestment > 0) {
      investments.push({
        seat,
        amount: totalInvestment,
        folded: player.status === PlayerStatus.FOLDED,
      });
    }
  }

  // If no investments, return empty
  if (investments.length === 0) {
    return [];
  }

  // Sort by investment (ascending)
  investments.sort((a, b) => a.amount - b.amount);

  const pots: Pot[] = [];
  let prevAmount = 0;

  for (let i = 0; i < investments.length; i++) {
    const current = investments[i];
    const allAtThisLevel = investments.slice(i); // Current + all higher investors
    const increment = current.amount - prevAmount;

    // Create pot for this level
    if (increment > 0) {
      // Pot includes chips from ALL players at this level (including folded)
      const potAmount = increment * allAtThisLevel.length;

      // But only non-folded players are eligible to win
      const eligibleSeats = allAtThisLevel.filter((inv) => !inv.folded).map((inv) => inv.seat);

      // Must have at least one eligible player
      // If everyone folded at this level, something went wrong in the game logic
      if (eligibleSeats.length === 0) {
        throw new CriticalStateError(
          `Side pot has no eligible players - all ${allAtThisLevel.length} players at this level have folded`,
          {
            potAmount,
            potLevel: i,
            investmentLevel: current.amount,
            allInvestors: allAtThisLevel.map((inv) => ({
              seat: inv.seat,
              amount: inv.amount,
              folded: inv.folded,
            })),
          }
        );
      }

      pots.push({
        amount: potAmount,
        eligibleSeats,
        type: i === 0 ? "MAIN" : "SIDE",
        capPerPlayer: current.amount,
      });
    }

    prevAmount = current.amount;
  }

  return pots;
}

/**
 * Calculate uncalled bet (when highest better has no callers)
 *
 * @param state Current game state
 * @returns Tuple of [uncalled amount, seat to return to]
 */
export function calculateUncalledBet(state: GameState): [number, number] | null {
  if (state.currentBets.size === 0) {
    return null;
  }

  // Find highest bet
  let maxBet = 0;
  let maxBetSeat = -1;
  let secondMaxBet = 0;

  for (const [seat, bet] of state.currentBets.entries()) {
    if (bet > maxBet) {
      secondMaxBet = maxBet;
      maxBet = bet;
      maxBetSeat = seat;
    } else if (bet > secondMaxBet) {
      secondMaxBet = bet;
    }
  }

  const uncalled = maxBet - secondMaxBet;

  if (uncalled > 0 && maxBetSeat >= 0) {
    return [uncalled, maxBetSeat];
  }

  return null;
}

/**
 * Return uncalled bet to player
 */
export function returnUncalledBet(state: GameState): GameState {
  const uncalled = calculateUncalledBet(state);

  if (!uncalled) {
    return state;
  }

  const [amount, seat] = uncalled;
  const player = state.players[seat];

  if (!player) {
    return state;
  }

  // Return chips to player
  const newPlayers = [...state.players];
  newPlayers[seat] = {
    ...player,
    stack: player.stack + amount,
    totalInvestedThisHand: player.totalInvestedThisHand - amount,
  };

  // Reduce current bet
  const newCurrentBets = new Map(state.currentBets);
  const currentBet = newCurrentBets.get(seat) ?? 0;
  newCurrentBets.set(seat, currentBet - amount);

  // Record to action history
  const actionRecord: ActionRecord = {
    action: {
      type: ActionType.UNCALLED_BET_RETURNED,
      playerId: player.id,
      amount,
      timestamp: state.timestamp,
    },
    seat,
    resultingPot: state.pots.reduce((sum, pot) => sum + pot.amount, 0),
    resultingStack: player.stack + amount,
    street: state.street,
  };

  return {
    ...state,
    players: newPlayers,
    currentBets: newCurrentBets,
    actionHistory: [...state.actionHistory, actionRecord],
  };
}

/**
 * Recalculate pots after street action completes
 * This is called before progressing to next street
 */
export function recalculatePots(state: GameState): GameState {
  // First, return any uncalled bet
  const newState = returnUncalledBet(state);

  // Calculate side pots based on all investments
  const pots = calculateSidePots(newState);

  // Reset betThisStreet for all players (bets collected into pots)
  const newPlayers = newState.players.map((p) => (p ? { ...p, betThisStreet: 0 } : null));

  return {
    ...newState,
    players: newPlayers,
    pots,
    currentBets: new Map(), // Bets collected into pots
  };
}
