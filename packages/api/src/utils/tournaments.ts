export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

export const defaultBlindStructure = (smallBlind: number, bigBlind: number): BlindLevel[] => [
  { smallBlind, bigBlind, ante: 0 },
  { smallBlind: smallBlind * 2, bigBlind: bigBlind * 2, ante: 0 },
  { smallBlind: smallBlind * 3, bigBlind: bigBlind * 3, ante: smallBlind },
  { smallBlind: smallBlind * 4, bigBlind: bigBlind * 4, ante: smallBlind * 2 },
];

export function computeTournamentTableDistribution(
  totalPlayers: number,
  tableMaxPlayers: number
): number[] {
  if (!Number.isInteger(totalPlayers) || totalPlayers < 2) {
    throw new Error("Tournament distribution requires at least two players");
  }
  if (!Number.isInteger(tableMaxPlayers) || tableMaxPlayers < 2) {
    throw new Error("Table maximum must be at least two players");
  }

  const tableCount = Math.ceil(totalPlayers / tableMaxPlayers);
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
