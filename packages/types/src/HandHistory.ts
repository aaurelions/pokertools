/**
 * Hand history data for export
 */
export interface HandHistoryData {
  readonly handId: string;
  readonly timestamp: number;
  readonly tableName: string;
  readonly buttonSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly players: ReadonlyArray<{
    readonly seat: number;
    readonly name: string;
    readonly startingStack: number;
    readonly hand: readonly string[] | null;
  }>;
  readonly board: readonly string[];
  readonly actions: readonly string[]; // Human-readable action strings
  readonly winners: ReadonlyArray<{
    readonly seat: number;
    readonly amount: number;
    readonly hand: readonly string[] | null;
  }>;
}
