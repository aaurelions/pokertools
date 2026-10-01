import { z } from "zod";

/** Liveness never asserts database, financial or signing readiness. */
export const HealthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  timestamp: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const DependencyCheckSchema = z.strictObject({
  status: z.enum(["ok", "degraded", "down"]),
  latencyMs: z.number().int().nonnegative(),
});

export const ReadinessResponseSchema = z.strictObject({
  status: z.literal("not_ready"),
  timestamp: z.number().int().nonnegative(),
  checks: z.strictObject({
    db: DependencyCheckSchema,
    redis: DependencyCheckSchema,
    queue: DependencyCheckSchema,
  }),
  migrations: z.strictObject({ status: z.literal("unverified") }),
  financial: z.strictObject({
    status: z.literal("blocked"),
    reasons: z
      .array(
        z.enum([
          "ASSET_LEDGER_UNVERIFIED",
          "RPC_QUORUM_UNVERIFIED",
          "RECONCILIATION_UNVERIFIED",
          "NATIVE_GAS_UNVERIFIED",
          "CUSTODY_WORKFLOW_UNVERIFIED",
        ])
      )
      .min(1),
  }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
