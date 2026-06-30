export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

/** Maximum number of tables allowed in a multi-table tournament. */
export const MAX_TOURNAMENT_TABLES = 10;

/** Maximum reconciliation iterations before aborting. */
export const MAX_RECONCILE_ITERATIONS = 5;

export const defaultBlindStructure = (smallBlind: number, bigBlind: number): BlindLevel[] => [
  { smallBlind, bigBlind, ante: 0 },
  { smallBlind: smallBlind * 2, bigBlind: bigBlind * 2, ante: 0 },
  { smallBlind: smallBlind * 3, bigBlind: bigBlind * 3, ante: smallBlind },
  { smallBlind: smallBlind * 4, bigBlind: bigBlind * 4, ante: smallBlind * 2 },
];

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
