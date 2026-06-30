export type TournamentStatus = "REGISTRATION" | "RUNNING" | "FINISHED" | "CANCELLED";

export type TournamentEntryStatus = "REGISTERED" | "ACTIVE" | "ELIMINATED" | "PAID";

export interface TournamentEntryDto {
  id: string;
  userId: string;
  username?: string;
  seat: number;
  status: TournamentEntryStatus;
  placement?: number | null;
  prize: number;
  /** Current table assignment (multi-table tournaments) */
  currentTableId?: string | null;
  currentSeat?: number | null;
}

export interface TournamentTableInfo {
  id: string;
  status: string;
  playerCount: number;
}

export interface TournamentListItem {
  id: string;
  name: string;
  status: TournamentStatus;
  tableId: string;
  buyIn: number;
  fee: number;
  startingStack: number;
  maxPlayers: number;
  tableMaxPlayers: number;
  balancingTolerance: number;
  registeredPlayers: number;
  prizePool: number;
  startsAt?: string | null;
}

export interface TournamentDetails extends TournamentListItem {
  blindStructure: Array<{ smallBlind: number; bigBlind: number; ante: number }>;
  payoutPercentages: number[];
  entries: TournamentEntryDto[];
  /** All tables belonging to this tournament (multi-table) */
  tables: TournamentTableInfo[];
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface StartTournamentResponse {
  success: boolean;
  tableIds: string[];
  distribution: number[];
}

export interface ReconcileTournamentResponse {
  success: boolean;
  tables: TournamentTableInfo[];
  entries: TournamentEntryDto[];
}

export interface TournamentPayoutDto {
  userId: string;
  placement: number;
  amount: number;
}

export interface SettleTournamentResponse {
  success: boolean;
  winnerUserId?: string;
  prize?: number;
  payouts?: TournamentPayoutDto[];
}
