/**
 * Blind level for tournament play
 */
export interface BlindLevel {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
}

/**
 * Table configuration
 */
export interface TableConfig {
  readonly smallBlind: number; // Small blind amount
  readonly bigBlind: number; // Big blind amount
  readonly ante?: number; // Ante amount (default: 0)
  readonly maxPlayers?: number; // Max players (2-10, default: 9)
  readonly initialStack?: number; // Starting stack for tournaments
  readonly blindStructure?: readonly BlindLevel[]; // Tournament blind schedule
  readonly timeBankSeconds?: number; // Time bank per player (default: 30)
  readonly timeBankDeductionSeconds?: number; // Seconds deducted per time bank activation (default: 10)
  readonly randomProvider?: () => number; // RNG function (default: Math.random)
  readonly rakePercent?: number; // Rake percentage (0-100, cash games only, default: 0)
  readonly rakeCap?: number; // Maximum rake per pot (cash games only)
  readonly noFlopNoDrop?: boolean; // No rake if hand ends preflop (cash games, default: true)
  readonly validateIntegrity?: boolean; // Enable chip conservation and state validation (default: true)
}
