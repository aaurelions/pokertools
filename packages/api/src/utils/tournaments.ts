import { config } from "../config.js";

export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

/** Maximum number of tables allowed in a multi-table tournament. */
export const MAX_TOURNAMENT_TABLES = config.MAX_TOURNAMENT_TABLES;

/** Maximum reconciliation iterations before aborting. */
export const MAX_RECONCILE_ITERATIONS = 5;

/**
 * Generates a 20-level geometric blind structure starting from the given
 * small blind / big blind pair.  Blinds grow by ~1.5× per level (doubling
 * roughly every two levels).  Antes kick in at level 3 as ~10 % of the big
 * blind and scale proportionally with subsequent levels.
 */
export const defaultBlindStructure = (smallBlind: number, bigBlind: number): BlindLevel[] => {
  const levels: BlindLevel[] = [];
  let sb = smallBlind;
  let bb = bigBlind;
  let ante = 0;
  for (let i = 0; i < 20; i++) {
    levels.push({ smallBlind: sb, bigBlind: bb, ante });
    sb = Math.round(sb * 1.5);
    bb = sb * 2;
    if (i >= 2) {
      ante = Math.max(1, Math.round(bb * 0.1));
    }
  }
  return levels;
};

/**
 * Validates that a blind structure has strictly increasing blinds.
 * Throws if any level's big blind is not greater than its small blind,
 * or if consecutive levels do not strictly increase.
 */
export function validateBlindStructure(levels: BlindLevel[]): void {
  if (!levels || levels.length === 0) return;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level.bigBlind <= level.smallBlind) {
      throw new Error(
        `Blind level ${i}: big blind (${level.bigBlind}) must be greater than small blind (${level.smallBlind})`
      );
    }
    if (i > 0) {
      const prev = levels[i - 1];
      if (level.smallBlind <= prev.smallBlind || level.bigBlind <= prev.bigBlind) {
        throw new Error(
          `Blind level ${i}: blinds must strictly increase (SB ${prev.smallBlind}→${level.smallBlind}, BB ${prev.bigBlind}→${level.bigBlind})`
        );
      }
    }
  }
}

export function computeTournamentTableDistribution(
  totalPlayers: number,
  tableMaxPlayers: number
): number[] {
  if (!Number.isInteger(totalPlayers) || totalPlayers < 2) {
    throw new Error("Tournament distribution requires at least two players");
  }
  if (!Number.isInteger(tableMaxPlayers) || tableMaxPlayers < 2 || tableMaxPlayers > 10) {
    throw new Error("Table maximum must be between 2 and 10 players");
  }

  const tableCount = Math.ceil(totalPlayers / tableMaxPlayers);
  if (tableCount > MAX_TOURNAMENT_TABLES) {
    throw new Error(
      `Tournament distribution would require ${tableCount} tables but the maximum is ${MAX_TOURNAMENT_TABLES}. Reduce total players or increase table size.`
    );
  }

  const base = Math.floor(totalPlayers / tableCount);
  const remainder = totalPlayers % tableCount;
  return Array.from({ length: tableCount }, (_, index) => (index < remainder ? base + 1 : base));
}

export function computeTournamentPayouts(
  prizePool: number,
  payoutPercentages: readonly number[]
): number[] {
  if (!Number.isInteger(prizePool) || prizePool < 0) {
    throw new Error("Prize pool must be a non-negative integer");
  }

  const payouts = payoutPercentages.map((percentage) => Math.floor((prizePool * percentage) / 100));
  const distributed = payouts.reduce((sum, payout) => sum + payout, 0);
  const remainder = prizePool - distributed;
  // Poker tournaments commonly award indivisible-chip rounding remainders to
  // the highest finishing position so total payouts always equal the prize pool.
  if (remainder > 0 && payouts.length > 0) payouts[0] += remainder;
  return payouts;
}
