import { GameState } from "@pokertools/types";
import { CriticalStateError } from "../errors/CriticalStateError";

/**
 * Audit chip conservation
 * Formula: ∑(player.stack) + ∑(pot.amount) + ∑(currentBets) = initialChips
 *
 * @param state Current game state
 * @param initialChips Total chips that should be in the game
 * @throws CriticalStateError if chips don't match
 */
export function auditChipConservation(state: GameState, initialChips: number): void {
  const currentChips = getInitialChips(state);

  if (currentChips !== initialChips) {
    throw new CriticalStateError(
      `Chip conservation violated: expected ${initialChips}, found ${currentChips}`,
      {
        expected: initialChips,
        actual: currentChips,
        difference: currentChips - initialChips,
        stacks: calculateStackTotal(state),
        pots: calculatePotTotal(state),
        bets: calculateBetTotal(state),
        street: state.street,
        handId: state.handId,
      }
    );
  }
}

/**
 * Calculate total chips in the game
 */
export function calculateTotalChips(state: GameState): number {
  return calculateStackTotal(state) + calculatePotTotal(state) + calculateBetTotal(state);
}

/**
 * Calculate total chips in player stacks
 */
export function calculateStackTotal(state: GameState): number {
  let total = 0;

  for (const player of state.players) {
    if (player) {
      total += player.stack;
    }
  }

  return total;
}

/**
 * Calculate total chips in pots
 */
export function calculatePotTotal(state: GameState): number {
  let total = 0;

  for (const pot of state.pots) {
    total += pot.amount;
  }

  return total;
}

/**
 * Calculate total chips in current bets
 */
export function calculateBetTotal(state: GameState): number {
  let total = 0;

  for (const bet of state.currentBets.values()) {
    total += bet;
  }

  return total;
}

/**
 * Get initial chips (sum of all starting stacks)
 * This calculates total chips in the game, which should remain constant (minus rake).
 *
 * - During a hand: stack + totalInvestedThisHand (chips in play + chips invested)
 * - After hand complete: stack + rake (all chips have been distributed, rake removed)
 */
export function getInitialChips(state: GameState): number {
  let total = 0;

  // Hand is complete if winners are declared AND pots/bets have been distributed
  // This ensures we don't switch modes mid-hand
  const handComplete =
    state.winners !== null && state.pots.length === 0 && state.currentBets.size === 0;

  for (const player of state.players) {
    if (player) {
      if (handComplete) {
        // Hand complete: only count current stacks
        total += player.stack;
      } else {
        // Hand in progress: stack + invested
        total += player.stack + player.totalInvestedThisHand;
      }
    }
  }

  // Add rake back to total after hand is complete (cash games only)
  // Rake is removed from the game, so we need to account for it
  if (handComplete) {
    total += state.rakeThisHand;
  }

  return total;
}

/**
 * Validate game state integrity
 * Checks multiple invariants beyond just chip conservation
 */
export function validateGameStateIntegrity(state: GameState): void {
  // 1. Chip conservation
  const initialChips = getInitialChips(state);
  auditChipConservation(state, initialChips);

  // 2. No negative stacks
  for (const player of state.players) {
    if (player && player.stack < 0) {
      throw new CriticalStateError(`Player ${player.id} has negative stack: ${player.stack}`, {
        playerId: player.id,
        stack: player.stack,
      });
    }
  }

  // 3. No negative bets
  for (const [seat, bet] of state.currentBets.entries()) {
    if (bet < 0) {
      throw new CriticalStateError(`Seat ${seat} has negative bet: ${bet}`, {
        seat,
        bet,
      });
    }
  }

  // 4. No negative pots
  for (let i = 0; i < state.pots.length; i++) {
    const pot = state.pots[i];
    if (pot.amount < 0) {
      throw new CriticalStateError(`Pot ${i} has negative amount: ${pot.amount}`, {
        potIndex: i,
        amount: pot.amount,
      });
    }
  }

  // 5. ActionTo must be valid seat or null
  if (state.actionTo !== null) {
    if (state.actionTo < 0 || state.actionTo >= state.maxPlayers) {
      throw new CriticalStateError(`Invalid actionTo: ${state.actionTo}`, {
        actionTo: state.actionTo,
        maxPlayers: state.maxPlayers,
      });
    }

    const player = state.players[state.actionTo];
    if (!player) {
      throw new CriticalStateError(`ActionTo points to empty seat: ${state.actionTo}`, {
        actionTo: state.actionTo,
      });
    }
  }

  // 6. Button must be valid or null
  if (state.buttonSeat !== null) {
    if (state.buttonSeat < 0 || state.buttonSeat >= state.maxPlayers) {
      throw new CriticalStateError(`Invalid buttonSeat: ${state.buttonSeat}`, {
        buttonSeat: state.buttonSeat,
        maxPlayers: state.maxPlayers,
      });
    }
  }
}
