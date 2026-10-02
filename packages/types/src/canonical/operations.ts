import { z } from "zod";
import { ChainIdSchema, CounterSchema, EpochMillisSchema, IdSchema } from "./primitives";
import { AssetIdSchema } from "./finance";

/**
 * Canonical operational contracts: durable financial incidents and readiness.
 *
 * Readiness is fail-closed: `READY` may not carry any blocking reason, and a
 * blocked readiness state must explain itself. Incidents are durable and must
 * record resolution metadata when closed.
 */

export const IncidentKindSchema = z.enum([
  "DEPOSIT_REORG",
  "WITHDRAWAL_REORG",
  "RPC_DISAGREEMENT",
  "TREASURY_SHORTFALL",
  "GAS_STARVATION",
  "AMBIGUOUS_CUSTODY_STATE",
  "AMBIGUOUS_BROADCAST",
  "NONCE_CONFLICT",
  "RECONCILIATION_MISMATCH",
  "RPC_QUORUM_FAILURE",
  "NATIVE_GAS_LOW",
  "LEDGER_IMBALANCE",
  "CUSTODY_FAILURE",
]);
export type IncidentKind = z.infer<typeof IncidentKindSchema>;

export const IncidentSeveritySchema = z.enum(["WARNING", "CRITICAL"]);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const IncidentStatusSchema = z.enum(["OPEN", "INVESTIGATING", "RESOLVED"]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

/**
 * Durable financial incident (internal/operator wire).
 *
 * The custody store maps its internal record directly onto these canonical
 * fields (`id`, `evidence`, `createdAt`); there is no `incidentId`/`detail`/
 * `openedAt` alias. Public finance clients must not receive incidents unless
 * operator-authorized.
 */
export const FinancialIncidentSchema = z
  .strictObject({
    id: IdSchema,
    kind: IncidentKindSchema,
    severity: IncidentSeveritySchema,
    status: IncidentStatusSchema,
    assetId: AssetIdSchema.nullable(),
    chainId: ChainIdSchema.nullable(),
    affectedId: IdSchema.nullable(),
    evidence: z.record(z.string(), z.unknown()),
    createdAt: EpochMillisSchema,
    resolvedAt: EpochMillisSchema.nullable(),
    operatorId: IdSchema.nullable(),
    operatorEvidence: z.record(z.string(), z.unknown()).nullable(),
  })
  .superRefine((incident, ctx) => {
    if (incident.status === "RESOLVED") {
      if (incident.resolvedAt === null) {
        ctx.addIssue({
          code: "custom",
          path: ["resolvedAt"],
          message: "Resolved incidents require resolvedAt",
        });
      }
      if (incident.operatorId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["operatorId"],
          message: "Resolved incidents require the resolving operator",
        });
      }
      if (incident.operatorEvidence === null) {
        ctx.addIssue({
          code: "custom",
          path: ["operatorEvidence"],
          message: "Resolved incidents require operator evidence",
        });
      }
      return;
    }
    if (incident.resolvedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Only resolved incidents may carry resolvedAt",
      });
    }
    if (incident.operatorId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["operatorId"],
        message: "Only resolved incidents may carry operatorId",
      });
    }
    if (incident.operatorEvidence !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["operatorEvidence"],
        message: "Only resolved incidents may carry operatorEvidence",
      });
    }
  });
export type FinancialIncident = z.infer<typeof FinancialIncidentSchema>;

export const ReadinessStateSchema = z.enum(["READY", "DEGRADED", "NOT_READY", "BLOCKED"]);
export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

export const ReadinessReasonSchema = z.enum([
  "ASSET_LEDGER_UNVERIFIED",
  "RPC_QUORUM_UNVERIFIED",
  "RECONCILIATION_UNVERIFIED",
  "NATIVE_GAS_UNVERIFIED",
  "CUSTODY_WORKFLOW_UNVERIFIED",
  "OPEN_CRITICAL_INCIDENT",
]);
export type ReadinessReason = z.infer<typeof ReadinessReasonSchema>;

export const ReadinessCheckSchema = z.strictObject({
  name: z.string().min(1),
  state: ReadinessStateSchema,
  latencyMs: CounterSchema.optional(),
  detail: z.string().optional(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

export const FinancialReadinessSchema = z
  .strictObject({
    state: ReadinessStateSchema,
    reasons: z.array(ReadinessReasonSchema),
    checks: z.array(ReadinessCheckSchema),
  })
  .superRefine((readiness, ctx) => {
    if (readiness.state === "READY" && readiness.reasons.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "READY readiness cannot carry blocking reasons",
      });
    }
    if (
      (readiness.state === "BLOCKED" || readiness.state === "NOT_READY") &&
      readiness.reasons.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Blocked/not-ready readiness must state a reason",
      });
    }
  });
export type FinancialReadiness = z.infer<typeof FinancialReadinessSchema>;
