/** Blind level for tournament play. */
export interface BlindLevel {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
}

/** Table configuration. */
export interface TableConfig {
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Ante amount (default: 0). */
  readonly ante?: number;
  /** Max players (2-10, default: 9). */
  readonly maxPlayers?: number;
  /** Starting stack for tournaments. */
  readonly initialStack?: number;
  /** Tournament blind schedule. */
  readonly blindStructure?: readonly BlindLevel[];
  /** Time bank per player in seconds (default: 30). */
  readonly timeBankSeconds?: number;
  /** Seconds deducted per time bank activation (default: 10). */
  readonly timeBankDeductionSeconds?: number;
  /** RNG override. Omit to use the engine's secure Node crypto RNG. */
  readonly randomProvider?: () => number;
  /** Rake percentage 0-100 (cash games only, default: 0). */
  readonly rakePercent?: number;
  /** Maximum rake per pot (cash games only). */
  readonly rakeCap?: number;
  /** If true, no rake when hand ends preflop (cash games, default: true). */
  readonly noFlopNoDrop?: boolean;
  /** Enables chip conservation and state validation (default: true). */
  readonly validateIntegrity?: boolean;
  /** If true, runs in client/optimistic mode (deals masked cards, skips strict checks). */
  readonly isClient?: boolean;
}
