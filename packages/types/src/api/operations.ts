import { z } from "zod";
import { FinancialReadinessSchema, ReadinessStateSchema } from "../canonical/operations";

/** Liveness never asserts database, financial or signing readiness. */
export const HealthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  timestamp: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const PlatformCheckSchema = z.strictObject({
  name: z.string().min(1),
  state: ReadinessStateSchema,
  mandatory: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  detail: z.string().min(1),
});

export const ReadinessResponseSchema = z
  .strictObject({
    status: z.enum(["ready", "not_ready"]),
    timestamp: z.number().int().nonnegative(),
    checks: z.array(PlatformCheckSchema).min(1),
    financial: FinancialReadinessSchema,
  })
  .superRefine((response, context) => {
    if (response.status !== "ready") return;
    if (
      response.financial.state !== "READY" ||
      response.checks.some((check) => check.mandatory && check.state !== "READY")
    ) {
      context.addIssue({
        code: "custom",
        message: "Readiness requires all mandatory checks to pass",
      });
    }
  });
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
