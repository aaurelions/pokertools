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
 * Canonical competition contracts (generic, NLHE-independent).
 *
 * A **competition** is a server-authoritative, single-table tournament with a
 * bounded roster of 2-10 pre-provisioned entrants. It is deliberately separate
 * from the self-register `Tournament` surface:
 *
 * - No open registration and no client-chosen seats: the orchestrator supplies
 *   the roster, PokerTools assigns authoritative registration seats and engine
 *   seats.
 * - `NONFINANCIAL`: zero entry, zero prize, mixed WALLET/SERVICE entrants.
 *   Nothing in this mode touches the asset ledger or the chip journal.
 * - `SPONSORED`: exactly one WALLET entrant pays an explicit asset entry; every
 *   other entrant is a zero-entry SERVICE participant. The fixed prize is
 *   financed by a platform sponsor and is paid only to a WALLET winner
 *   (a SERVICE winner is never a financial owner and the prize is recorded
 *   unclaimed).
 *
 * Public HTTP surface (planned/implemented by the API package):
 *
 * - `POST /competitions` — orchestration scope `competition:orchestrate` (or an
 *   ADMIN wallet). Strict create request, idempotent on `idempotencyKey`.
 * - `GET /competitions/:id` — authenticated read.
 * - `POST /competitions/:id/opt-in` — the provisioned WALLET entrant only;
 *   atomically charges the explicit entry. Idempotent.
 * - `POST /competitions/:id/start` — orchestration only. Fails closed until the
 *   roster is complete (and, for `SPONSORED`, the entry is paid).
 * - `POST /competitions/:id/settle` — orchestration only. Idempotent; pays the
 *   sponsor-financed prize exactly once.
 *
 * Identity model:
 *
 * - `principalId` is the durable principal identity (`User.id`). Rotating an
 *   agent credential never changes it, so a competition entrant reference is
 *   stable across credential rotation.
 * - `kind` is a claim that MUST match the durable principal kind; a mismatch
 *   fails the request closed.
 * - SERVICE entrant credentials stay table-scoped (`table:observe|act|chat`)
 *   and may be restricted to the competition table/seat. No competition route
 *   is reachable with a table-scoped credential.
 *
 * Money model:
 *
 * - All amounts are canonical atomic decimal strings for one `assetId`.
 * - `SPONSORED` entry and prize require an ACTIVE persisted `EconomicPolicy`
 *   for the referenced asset; amounts must convert exactly (no rounding).
 * - Entry moves atomic value from the WALLET entrant; the prize moves atomic
 *   value from the sponsor's operator account. There is no prize pool and no
 *   implicit chip conversion.
 *
 * This file is the single public contract. The API validates requests against
 * it and the SDK validates responses against it, so wire drift fails closed on
 * both sides.
 */

/** Competition lifecycle, mirroring the authoritative DB status. */
export const CompetitionStatusSchema = z.enum(["REGISTRATION", "RUNNING", "FINISHED", "CANCELLED"]);
export type CompetitionStatus = z.infer<typeof CompetitionStatusSchema>;

/**
 * `NONFINANCIAL`: zero entry/prize.
 * `SPONSORED`: one paying WALLET entrant plus zero-entry SERVICE entrants and a
 * sponsor-financed fixed prize.
 */
export const CompetitionModeSchema = z.enum(["NONFINANCIAL", "SPONSORED"]);
export type CompetitionMode = z.infer<typeof CompetitionModeSchema>;

/**
 * Per-entrant economic state. `PROVISIONED` is the initial authoritative seat
 * assignment; `OPTED_IN` exists only for the single paying WALLET entrant after
 * an exact atomic entry has been committed.
 */
export const CompetitionEntryStateSchema = z.enum(["PROVISIONED", "OPTED_IN"]);
export type CompetitionEntryState = z.infer<typeof CompetitionEntryStateSchema>;

/**
 * Prize disposition for a finished competition.
 * - `NOT_APPLICABLE`: nonfinancial competition.
 * - `PENDING`: paid competition not yet settled.
 * - `PAID`: fixed sponsor prize credited to the WALLET winner exactly once.
 * - `UNCLAIMED_SERVICE_WINNER`: a SERVICE won; SERVICE is never a financial
 *   owner, so no ledger movement occurs.
 */
export const CompetitionPrizeStatusSchema = z.enum([
  "NOT_APPLICABLE",
  "PENDING",
  "PAID",
  "UNCLAIMED_SERVICE_WINNER",
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
 * Paid (`SPONSORED`) terms. `entry` is charged to the single WALLET entrant;
 * `prize` is financed by `sponsorPrincipalId` and paid only to a WALLET winner.
 * Both assets must have an ACTIVE persisted EconomicPolicy and the amounts must
 * be exactly representable (fail closed, never rounded).
 */
export const CompetitionPaidTermsSchema = z.strictObject({
  entry: CompetitionAssetAmountSchema,
  prize: CompetitionAssetAmountSchema,
  sponsorPrincipalId: PrincipalIdSchema,
});
export type CompetitionPaidTerms = z.infer<typeof CompetitionPaidTermsSchema>;

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

/** Public entrant projection with the authoritative assigned seat. */
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
  /** Null for `NONFINANCIAL`; the validated paid terms for `SPONSORED`. */
  paidTerms: CompetitionPaidTermsSchema.nullable(),
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
    paidTerms: CompetitionPaidTermsSchema.optional(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .superRefine((request, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < request.entrants.length; index++) {
      const entrant = request.entrants[index];
      if (seen.has(entrant.principalId)) {
        ctx.addIssue({
          code: "custom",
          path: ["entrants", index, "principalId"],
          message: "Duplicate competition entrant",
        });
      }
      seen.add(entrant.principalId);
    }

    if (request.smallBlind !== undefined && request.bigBlind === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["bigBlind"],
        message: "bigBlind is required when smallBlind is supplied",
      });
    }

    if (request.mode === "NONFINANCIAL") {
      if (request.paidTerms !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["paidTerms"],
          message: "NONFINANCIAL competitions must not carry paid terms",
        });
      }
      return;
    }

    if (request.paidTerms === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["paidTerms"],
        message: "SPONSORED competitions require explicit paid terms",
      });
      return;
    }

    const wallets = request.entrants.filter((entrant) => entrant.kind === "WALLET");
    const services = request.entrants.filter((entrant) => entrant.kind === "SERVICE");
    if (wallets.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["entrants"],
        message: "SPONSORED competitions require exactly one WALLET entrant",
      });
    }
    if (services.length < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["entrants"],
        message: "SPONSORED competitions require at least one zero-entry SERVICE entrant",
      });
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
 * `POST /competitions/:id/opt-in` (provisioned WALLET entrant only). The route
 * first resolves the entrant from the authenticated principal; no principal id
 * is accepted from the body.
 */
export const OptInCompetitionRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
});
export type OptInCompetitionRequest = z.infer<typeof OptInCompetitionRequestSchema>;

export const OptInCompetitionResponseSchema = z.strictObject({
  success: z.literal(true),
  competitionId: IdSchema,
  principalId: PrincipalIdSchema,
  entryState: z.literal("OPTED_IN"),
  entry: CompetitionAssetAmountSchema,
  /** Persisted exact conversion evidence (idempotent on replay). */
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
