/**
 * Tournament REST DTOs.
 *
 * Aliases of the canonical runtime schemas in `canonical/rest.ts`; no parallel
 * hand-rolled declarations remain in this module.
 */

import type {
  ReconcileTournamentResponseWire,
  SettleTournamentResponseWire,
  StartTournamentResponseWire,
  TournamentDetailsWire,
  TournamentEntryStatusWire,
  TournamentEntryWire,
  TournamentListItemWire,
  TournamentPayoutDtoWire,
  TournamentStatusWire,
  TournamentTableInfoWire,
} from "../canonical/rest";

export type TournamentStatus = TournamentStatusWire;
export type TournamentEntryStatus = TournamentEntryStatusWire;
export type TournamentEntryDto = TournamentEntryWire;
export type TournamentTableInfo = TournamentTableInfoWire;
export type TournamentListItem = TournamentListItemWire;
export type TournamentDetails = TournamentDetailsWire;
export type StartTournamentResponse = StartTournamentResponseWire;
export type ReconcileTournamentResponse = ReconcileTournamentResponseWire;
export type TournamentPayoutDto = TournamentPayoutDtoWire;
export type SettleTournamentResponse = SettleTournamentResponseWire;
