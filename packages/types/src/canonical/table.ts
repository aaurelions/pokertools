import { z } from "zod";
import {
  ActionIdSchema,
  ChipAmountSchema,
  CounterSchema,
  HandIdSchema,
  IdSchema,
  PositiveChipAmountSchema,
  RequestIdSchema,
  TableIdSchema,
  TurnIdSchema,
  EpochMillisSchema,
} from "./primitives";
import { PublicWireStateSchema } from "./masked-state";

/**
 * Canonical turn / observation / legal-action / action-submission contracts.
 *
 * A `SeatObservation` is the authoritative decision boundary handed to an
 * acting seat: the masked public state plus the exact legal actions for the
 * current turn. `CanonicalActionRequest` references that turn by opaque ids,
 * so the actor is never encoded in the request body (auth derives it).
 */

/** Uppercase engine action families that can appear as legal actions. */
export const LegalActionFamilySchema = z.enum([
  "DEAL",
  "CHECK",
  "CALL",
  "RAISE",
  "BET",
  "FOLD",
  "SHOW",
  "MUCK",
  "TIME_BANK",
  "STAND",
  "NEXT_BLIND_LEVEL",
]);
export type LegalActionFamily = z.infer<typeof LegalActionFamilySchema>;

const CHIP_FAMILIES: ReadonlySet<LegalActionFamily> = new Set(["BET", "RAISE"]);

/**
 * A single legal action offered for the current turn.
 *
 * - `actionId` is opaque and must be echoed back on submission
 * - `family` is the engine action family (uppercase)
 * - `minAmount` / `maxAmount` bound a chip amount when the family takes one
 * - `amount` is an optional precomputed exact amount (all-in, fixed call, ...)
 */
export const LegalActionSchema = z
  .strictObject({
    actionId: ActionIdSchema,
    family: LegalActionFamilySchema,
    minAmount: ChipAmountSchema.optional(),
    maxAmount: ChipAmountSchema.optional(),
    amount: ChipAmountSchema.optional(),
  })
  .superRefine((action, ctx) => {
    const { minAmount, maxAmount, amount } = action;
    if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount) {
      ctx.addIssue({
        code: "custom",
        path: ["minAmount"],
        message: "minAmount must not exceed maxAmount",
      });
    }
    if (amount !== undefined) {
      if (minAmount !== undefined && amount < minAmount) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: "amount below minAmount" });
      }
      if (maxAmount !== undefined && amount > maxAmount) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: "amount above maxAmount" });
      }
      if (!CHIP_FAMILIES.has(action.family) && action.family !== "CALL") {
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message: "This action family takes no amount",
        });
      }
    }
    if (CHIP_FAMILIES.has(action.family) && (minAmount === undefined || maxAmount === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["minAmount"],
        message: "Betting families require minAmount and maxAmount",
      });
    }
  });
export type LegalAction = z.infer<typeof LegalActionSchema>;

/**
 * Authoritative per-seat observation at a turn boundary.
 *
 * `state` is the canonical {@link PublicWireState} (distinct from the engine
 * `PublicState` interface because Maps are serialized as records). Servers must
 * produce it with `toPublicWireState`; clients must not receive the engine
 * object directly.
 */
export const SeatObservationSchema = z
  .strictObject({
    tableId: TableIdSchema,
    handId: HandIdSchema,
    turnId: TurnIdSchema,
    version: CounterSchema,
    eventSeq: CounterSchema,
    state: PublicWireStateSchema,
    legalActions: z.array(LegalActionSchema),
  })
  .superRefine((observation, context) => {
    if (
      observation.handId !== observation.state.handId ||
      observation.version !== observation.state.version
    ) {
      context.addIssue({
        code: "custom",
        message: "Observation identity and version must match its state",
      });
    }
    if (
      new Set(observation.legalActions.map((action) => action.actionId)).size !==
      observation.legalActions.length
    ) {
      context.addIssue({ code: "custom", message: "Legal action identities must be unique" });
    }
  });
export type SeatObservation = z.infer<typeof SeatObservationSchema>;

/**
 * Canonical action submission.
 *
 * Strict: the body may only carry ids and an optional chip amount. Actor
 * fields (`playerId`, `principalId`, `seat`, `actor`, ...) are rejected, and
 * the engine's internal `Action.playerId` is never accepted on the wire.
 */
export const CanonicalActionRequestSchema = z.strictObject({
  requestId: RequestIdSchema,
  turnId: TurnIdSchema,
  expectedVersion: CounterSchema,
  actionId: ActionIdSchema,
  amount: PositiveChipAmountSchema.optional(),
});
export type CanonicalActionRequest = z.infer<typeof CanonicalActionRequestSchema>;

/** Receipt returned after a canonical action is durably applied. */
export const CanonicalActionReceiptSchema = z.strictObject({
  requestId: RequestIdSchema,
  tableId: TableIdSchema,
  handId: HandIdSchema,
  turnId: TurnIdSchema,
  actionId: ActionIdSchema,
  version: CounterSchema,
  eventSeq: CounterSchema,
  acceptedAt: EpochMillisSchema,
});
export type CanonicalActionReceipt = z.infer<typeof CanonicalActionReceiptSchema>;

/**
 * The single shared action response for API and SDK.
 *
 * - `receipt` identifies the accepted submitted turn/action and the new
 *   version/eventSeq/time.
 * - `observation` is generated from the resulting snapshot: the current turnId,
 *   masked wire state and legal actions for the **same** principal.
 *
 * The full result must be persisted as the idempotency response. A duplicate
 * request with the same principal and complete payload returns the original
 * stored result, not a newly advanced state.
 */
export const CanonicalActionResultSchema = z
  .strictObject({
    receipt: CanonicalActionReceiptSchema,
    observation: SeatObservationSchema,
  })
  .superRefine((result, context) => {
    const { receipt, observation } = result;
    if (
      receipt.tableId !== observation.tableId ||
      receipt.handId !== observation.handId ||
      receipt.version !== observation.version ||
      receipt.eventSeq !== observation.eventSeq
    ) {
      context.addIssue({
        code: "custom",
        message: "Action receipt must identify its resulting observation",
      });
    }
  });
export type CanonicalActionResult = z.infer<typeof CanonicalActionResultSchema>;

/** Canonical buy-in / seat claim (seat is explicit only on this money path). */
export const SeatClaimSchema = z.strictObject({
  tableId: TableIdSchema,
  principalId: IdSchema,
  seat: z.number().int().nonnegative().max(9),
  handId: HandIdSchema.optional(),
});
export type SeatClaim = z.infer<typeof SeatClaimSchema>;
