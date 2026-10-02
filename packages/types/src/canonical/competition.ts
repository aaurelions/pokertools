import { z } from "zod";
import {
  AtomicAmountSchema,
  CounterSchema,
  IdSchema,
  PositiveChipAmountSchema,
  PrincipalIdSchema,
} from "./primitives";
import { AssetIdSchema } from "./finance";
import { PrincipalKindSchema } from "./principal";

/**
 * Canonical competition contracts (generic capability).
 *
 * A **competition** is a server-authoritative, single-table tournament with a
 * bounded roster of 2-10 pre-provisioned entrants. It is deliberately separate
 * from the self-register `Tournament` surface:
 *
 * - No open registration and no client-chosen seats: the orchestrator supplies
 *   the roster, PokerTools assigns authoritative registration seats and engine
 *   seats (the roster is provisioned into the authoritative tournament/game
 *   machinery; there is no second poker runner).
 * - `NONFINANCIAL`: zero entry, zero prize, mixed WALLET/SERVICE entrants.
 *   Nothing in this mode touches the asset ledger or the chip journal.
 * - `ASSET`: explicit asset economics. The roster may configure one or more
 *   WALLET entry payers, each of whom must explicitly opt in and pay their
 *   configured amount. SERVICE entrants are always zero-entry and are never
 *   financial owners. The fixed prize is reserved up front from an authorized
 *   sponsor account and paid only to a WALLET winner; when no WALLET can be a
 *   financial winner the reservation is released back to the sponsor.
 *
 * Public HTTP surface (implemented by the API package):
 *
 * - `POST /competitions` — orchestration scope `competition:orchestrate` (or an
 *   ADMIN wallet). Strict create request, idempotent on `idempotencyKey`.
 * - `GET /competitions/:id` — authenticated privacy-preserving projection.
 * - `POST /competitions/:id/opt-in` — a configured WALLET payer only; charges
 *   that payer's explicit entry atomically. Idempotent.
 * - `POST /competitions/:id/start` — orchestration only. Fails closed until the
 *   roster is complete and every entry obligation is settled.
 * - `POST /competitions/:id/settle` — orchestration only. Idempotent; settles
 *   the prize reservation exactly once.
 * - `POST /competitions/:id/agent-credentials` — orchestration only. Issues or
 *   rotates a table-scoped agent credential for a SERVICE entrant of this
 *   competition; the credential is confined to the competition table (and
 *   optionally the assigned seat).
 *
 * Identity and privacy model:
 *
 * - `principalId` is the durable principal identity (`User.id`). Rotating an
 *   agent credential never changes it, so a competition entrant reference is
 *   stable across credential rotation.
 * - `kind` is a claim that MUST match the durable principal kind; a mismatch
 *   fails the request closed.
 * - Projections expose only opaque principal ids, kind, authoritative seat and
 *   entry state. They never expose wallet addresses, usernames, credentials or
 *   raw audit records.
 * - SERVICE entrant credentials stay table-scoped (`table:observe|act|chat`)
 *   and are restricted to the competition table. No competition route is
 *   reachable with a table-scoped credential.
 *
 * Money model:
 *
 * - All amounts are canonical atomic decimal strings for one `assetId`.
 * - Assets must be provisioned in the database and ACTIVE. There is no public
 *   asset or rate provisioning route.
 * - Entry moves atomic value from a configured WALLET payer to the authorized
 *   sponsor's operator account. The prize is reserved from the sponsor's
 *   operator account before admission and held until settlement. Every
 *   movement is a balanced, idempotent atomic journal.
 * - The sponsor is authorized delegation: either the organizer itself (when the
 *   organizer is a WALLET) or a fixed platform sponsor account. An orchestrator
 *   can never direct arbitrary wallets to fund a prize.
 */

/** Competition lifecycle, mirroring the authoritative DB status. */
export const CompetitionStatusSchema = z.enum(["REGISTRATION", "RUNNING", "FINISHED", "CANCELLED"]);
export type CompetitionStatus = z.infer<typeof CompetitionStatusSchema>;

/**
 * `NONFINANCIAL`: zero entry/prize.
 * `ASSET`: explicit asset entry configured per WALLET payer plus an authorized
 * sponsor-reserved prize.
 */
export const CompetitionModeSchema = z.enum(["NONFINANCIAL", "ASSET"]);
export type CompetitionMode = z.infer<typeof CompetitionModeSchema>;

/**
 * Per-entrant economic state. `NOT_REQUIRED` is every SERVICE entrant and any
 * WALLET entrant that is not a configured payer. `PENDING` is a configured
 * WALLET payer that has not opted in yet. `PAID` means the exact atomic entry
 * has been committed.
 */
export const CompetitionEntryStateSchema = z.enum(["NOT_REQUIRED", "PENDING", "PAID"]);
export type CompetitionEntryState = z.infer<typeof CompetitionEntryStateSchema>;

/**
 * Prize reservation disposition.
 * - `NOT_APPLICABLE`: nonfinancial competition.
 * - `RESERVED`: the fixed prize is held from the authorized sponsor and the
 *   competition may start.
 * - `PAID`: the reserved prize was credited to a WALLET winner exactly once.
 * - `RELEASED`: settlement produced no financial winner (e.g. a SERVICE won);
 *   the reservation was returned to the sponsor with no value created.
 */
export const CompetitionPrizeStatusSchema = z.enum([
  "NOT_APPLICABLE",
  "RESERVED",
  "PAID",
  "RELEASED",
]);
export type CompetitionPrizeStatus = z.infer<typeof CompetitionPrizeStatusSchema>;

/** Positive canonical atomic amount (an amount that must move value). */
export const PositiveAtomicAmountSchema = AtomicAmountSchema.refine(
  (value) => BigInt(value) > 0n,
  "Atomic amount must be positive"
);
export type PositiveAtomicAmount = z.infer<typeof PositiveAtomicAmountSchema>;

/** An explicit asset amount: canonical asset id plus atomic value. */
export const CompetitionAssetAmountSchema = z.strictObject({
  assetId: AssetIdSchema,
  amountAtomic: PositiveAtomicAmountSchema,
});
export type CompetitionAssetAmount = z.infer<typeof CompetitionAssetAmountSchema>;

/**
 * One configured WALLET entry payer. `amountAtomic` overrides the competition
 * default entry amount; absent means the default applies.
 */
export const CompetitionEntryPayerSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  amountAtomic: PositiveAtomicAmountSchema.optional(),
});
export type CompetitionEntryPayer = z.infer<typeof CompetitionEntryPayerSchema>;

/**
 * Explicit asset entry terms. `players` accepts one or more WALLET payers;
 * products may configure a single payer while the platform capability stays
 * generic. SERVICE principals can never appear here.
 */
export const CompetitionEntryTermsSchema = z.strictObject({
  assetId: AssetIdSchema,
  amountAtomic: PositiveAtomicAmountSchema,
  payers: z.array(CompetitionEntryPayerSchema).min(1).max(10),
});
export type CompetitionEntryTerms = z.infer<typeof CompetitionEntryTermsSchema>;

/**
 * Sponsor-reserved fixed prize. `sponsorPrincipalId` must be an authorized
 * delegation (the organizer as WALLET, or a fixed platform sponsor account);
 * the reservation is taken from that account before admission.
 */
export const CompetitionPrizeTermsSchema = z.strictObject({
  assetId: AssetIdSchema,
  amountAtomic: PositiveAtomicAmountSchema,
  sponsorPrincipalId: PrincipalIdSchema,
});
export type CompetitionPrizeTerms = z.infer<typeof CompetitionPrizeTermsSchema>;

export const CompetitionTermsSchema = z.strictObject({
  entry: CompetitionEntryTermsSchema,
  prize: CompetitionPrizeTermsSchema,
});
export type CompetitionTerms = z.infer<typeof CompetitionTermsSchema>;

/**
 * A roster entry supplied by the orchestrator. The orchestrator does NOT choose
 * a seat or a credential; it references a durable principal identity. The
 * server validates `kind` against the durable principal and assigns seats.
 */
export const CompetitionEntrantSpecSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  kind: PrincipalKindSchema,
});
export type CompetitionEntrantSpec = z.infer<typeof CompetitionEntrantSpecSchema>;

/** Privacy-preserving entrant projection with the authoritative assigned seat. */
export const CompetitionEntrantSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  kind: PrincipalKindSchema,
  /** Authoritative server-assigned registration seat (0..9). */
  seat: CounterSchema,
  entryState: CompetitionEntryStateSchema,
});
export type CompetitionEntrant = z.infer<typeof CompetitionEntrantSchema>;

/** Authoritative competition projection returned by every competition route. */
export const CompetitionSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(100),
  mode: CompetitionModeSchema,
  status: CompetitionStatusSchema,
  /** Backing engine table. Engine seats equal registration seats. */
  tableId: IdSchema,
  /** Durable identity of the provisioning principal (SERVICE or ADMIN wallet). */
  organizerPrincipalId: PrincipalIdSchema,
  maxEntrants: z.number().int().min(2).max(10),
  startingStack: PositiveChipAmountSchema,
  smallBlind: PositiveChipAmountSchema,
  bigBlind: PositiveChipAmountSchema,
  entrants: z.array(CompetitionEntrantSchema).min(2).max(10),
  /** Null for `NONFINANCIAL`; the validated explicit economics for `ASSET`. */
  terms: CompetitionTermsSchema.nullable(),
  prizeStatus: CompetitionPrizeStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});
export type Competition = z.infer<typeof CompetitionSchema>;

/**
 * `POST /competitions` request. Strict: seats are never client-supplied and
 * financial terms are structurally impossible to smuggle into a free
 * competition. Idempotent on `idempotencyKey`.
 */
export const CreateCompetitionRequestSchema = z
  .strictObject({
    name: z.string().min(1).max(100),
    mode: CompetitionModeSchema,
    entrants: z.array(CompetitionEntrantSpecSchema).min(2).max(10),
    /** Optional engine configuration; server defaults: 1000 / 10 / 20. */
    startingStack: PositiveChipAmountSchema.optional(),
    smallBlind: PositiveChipAmountSchema.optional(),
    bigBlind: PositiveChipAmountSchema.optional(),
    terms: CompetitionTermsSchema.optional(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .superRefine((request, ctx) => {
    const entrantIds = new Set<string>();
    for (let index = 0; index < request.entrants.length; index++) {
      const entrant = request.entrants[index];
      if (entrantIds.has(entrant.principalId)) {
        ctx.addIssue({
          code: "custom",
          path: ["entrants", index, "principalId"],
          message: "Duplicate competition entrant",
        });
      }
      entrantIds.add(entrant.principalId);
    }

    if (request.smallBlind !== undefined && request.bigBlind === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["bigBlind"],
        message: "bigBlind is required when smallBlind is supplied",
      });
    }

    if (request.mode === "NONFINANCIAL") {
      if (request.terms !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["terms"],
          message: "NONFINANCIAL competitions must not carry asset terms",
        });
      }
      return;
    }

    if (request.terms === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["terms"],
        message: "ASSET competitions require explicit entry and prize terms",
      });
      return;
    }

    const payerIds = new Set<string>();
    for (let index = 0; index < request.terms.entry.payers.length; index++) {
      const payer = request.terms.entry.payers[index];
      if (payerIds.has(payer.principalId)) {
        ctx.addIssue({
          code: "custom",
          path: ["terms", "entry", "payers", index, "principalId"],
          message: "Duplicate entry payer",
        });
      }
      payerIds.add(payer.principalId);
      const entrant = request.entrants.find((entry) => entry.principalId === payer.principalId);
      if (!entrant) {
        ctx.addIssue({
          code: "custom",
          path: ["terms", "entry", "payers", index, "principalId"],
          message: "Entry payer must be a roster entrant",
        });
      } else if (entrant.kind !== "WALLET") {
        ctx.addIssue({
          code: "custom",
          path: ["terms", "entry", "payers", index, "principalId"],
          message: "SERVICE entrants are always zero-entry",
        });
      }
    }
  });
export type CreateCompetitionRequest = z.infer<typeof CreateCompetitionRequestSchema>;

export const CreateCompetitionResponseSchema = z.strictObject({
  success: z.literal(true),
  competition: CompetitionSchema,
  /** True when an idempotent replay returned the originally created roster. */
  replayed: z.boolean(),
});
export type CreateCompetitionResponse = z.infer<typeof CreateCompetitionResponseSchema>;

export const GetCompetitionResponseSchema = z.strictObject({
  competition: CompetitionSchema,
});
export type GetCompetitionResponse = z.infer<typeof GetCompetitionResponseSchema>;

/**
 * `POST /competitions/:id/opt-in` (configured WALLET payer only). The route
 * resolves the payer from the authenticated principal; no principal id is
 * accepted from the body.
 */
export const OptInCompetitionRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
});
export type OptInCompetitionRequest = z.infer<typeof OptInCompetitionRequestSchema>;

export const OptInCompetitionResponseSchema = z.strictObject({
  success: z.literal(true),
  competitionId: IdSchema,
  principalId: PrincipalIdSchema,
  entryState: z.literal("PAID"),
  entry: CompetitionAssetAmountSchema,
  /** Persisted exact journal/conversion evidence (idempotent on replay). */
  conversionId: IdSchema,
});
export type OptInCompetitionResponse = z.infer<typeof OptInCompetitionResponseSchema>;

/** `POST /competitions/:id/start` (orchestration only). */
export const StartCompetitionRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
});
export type StartCompetitionRequest = z.infer<typeof StartCompetitionRequestSchema>;

export const CompetitionSeatAssignmentSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  seat: CounterSchema.max(9),
});
export type CompetitionSeatAssignment = z.infer<typeof CompetitionSeatAssignmentSchema>;

export const StartCompetitionResponseSchema = z.strictObject({
  success: z.literal(true),
  competitionId: IdSchema,
  tableId: IdSchema,
  seats: z.array(CompetitionSeatAssignmentSchema).min(2).max(10),
});
export type StartCompetitionResponse = z.infer<typeof StartCompetitionResponseSchema>;

/** Placement projection produced by authoritative settlement. */
export const CompetitionPlacementSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  kind: PrincipalKindSchema,
  placement: CounterSchema.min(1),
  prize: CompetitionAssetAmountSchema.nullable(),
});
export type CompetitionPlacement = z.infer<typeof CompetitionPlacementSchema>;

/** `POST /competitions/:id/settle` (orchestration only, idempotent). */
export const SettleCompetitionRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
});
export type SettleCompetitionRequest = z.infer<typeof SettleCompetitionRequestSchema>;

export const SettleCompetitionResponseSchema = z.strictObject({
  success: z.literal(true),
  competitionId: IdSchema,
  winnerPrincipalId: PrincipalIdSchema,
  winnerKind: PrincipalKindSchema,
  prizeStatus: CompetitionPrizeStatusSchema,
  /** Present only when atomic value actually moved to a WALLET winner. */
  prize: CompetitionAssetAmountSchema.nullable(),
  placements: z.array(CompetitionPlacementSchema).min(2).max(10),
});
export type SettleCompetitionResponse = z.infer<typeof SettleCompetitionResponseSchema>;

// ============================================================================
// Agent credential provisioning (orchestration-scoped)
// ============================================================================

/** Table scopes only: an agent credential can never carry orchestration. */
export const AgentTableScopeSchema = z.enum(["table:observe", "table:act", "table:chat"]);
export type AgentTableScope = z.infer<typeof AgentTableScopeSchema>;

/**
 * `POST /competitions/:id/agent-credentials` request. The principal must be a
 * SERVICE entrant of this competition; the issued credential is always bound to
 * the competition table (and optionally the entrant's authoritative seat).
 *
 * Without `credentialId` the route mints a fresh credential (safe to call again
 * after a restart; callers keep only the returned one-time token). With
 * `credentialId` the existing credential is rotated in place for the same
 * durable principal and the old secret stops working.
 */
export const IssueAgentCredentialRequestSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  name: z.string().min(1).max(64),
  /** Defaults to every table scope. */
  scopes: z.array(AgentTableScopeSchema).min(1).max(3).optional(),
  seat: z.number().int().min(0).max(9).optional(),
  expiresAt: z.string().datetime().optional(),
  /** Rotate this credential in place instead of minting a new one. */
  credentialId: IdSchema.optional(),
});
export type IssueAgentCredentialRequest = z.infer<typeof IssueAgentCredentialRequestSchema>;

/** One-time plaintext `token`; only its digest is ever persisted. */
export const IssuedAgentCredentialSchema = z.strictObject({
  credentialId: IdSchema,
  principalId: PrincipalIdSchema,
  competitionId: IdSchema,
  tableId: IdSchema,
  name: z.string().min(1).max(64),
  scopes: z.array(AgentTableScopeSchema).min(1),
  seat: z.number().int().min(0).max(9).nullable(),
  expiresAt: z.string().datetime().nullable(),
  token: z.string().min(1),
  /** True when an existing credential for the principal was rotated. */
  rotated: z.boolean(),
});
export type IssuedAgentCredential = z.infer<typeof IssuedAgentCredentialSchema>;
