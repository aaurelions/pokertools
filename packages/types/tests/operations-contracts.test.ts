import {
  CanonicalActionRequestSchema,
  HealthResponseSchema,
  ReadinessResponseSchema,
  IncidentKindSchema,
} from "../src";

describe("operational and action boundaries", () => {
  test("the incident protocol represents ambiguous broadcasts retained by custody", () => {
    expect(IncidentKindSchema.parse("AMBIGUOUS_BROADCAST")).toBe("AMBIGUOUS_BROADCAST");
  });
  test("liveness makes no financial-readiness assertion", () => {
    expect(HealthResponseSchema.parse({ status: "ok", timestamp: 1 })).toEqual({
      status: "ok",
      timestamp: 1,
    });
    expect(
      HealthResponseSchema.safeParse({ status: "ok", timestamp: 1, rpcUrl: "secret" }).success
    ).toBe(false);
  });
  test("unverified finance cannot be represented as ready", () => {
    expect(ReadinessResponseSchema.safeParse({ status: "ready" }).success).toBe(false);
  });
  test("readiness cannot conceal a failed mandatory probe", () => {
    const response = {
      status: "ready",
      timestamp: 1,
      checks: [{ name: "database", state: "READY", mandatory: true, latencyMs: 1, detail: "OK" }],
      financial: { state: "READY", reasons: [], checks: [] },
    };
    expect(ReadinessResponseSchema.safeParse(response).success).toBe(true);
    expect(
      ReadinessResponseSchema.safeParse({
        ...response,
        checks: [{ ...response.checks[0], state: "NOT_READY" }],
      }).success
    ).toBe(false);
  });
  test("canonical action requires a safe integer chip amount when present", () => {
    const base = { requestId: "r1", turnId: "t1", expectedVersion: 1, actionId: "a1" };
    for (const amount of [NaN, Infinity, 1.1, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(CanonicalActionRequestSchema.safeParse({ ...base, amount }).success).toBe(false);
    }
    expect(CanonicalActionRequestSchema.safeParse({ ...base, amount: 50 }).success).toBe(true);
  });
  test("canonical action rejects caller-selected actor identity and type-body fields", () => {
    const base = { requestId: "r1", turnId: "t1", expectedVersion: 1, actionId: "a1" };
    expect(CanonicalActionRequestSchema.safeParse({ ...base, playerId: "victim" }).success).toBe(
      false
    );
    expect(CanonicalActionRequestSchema.safeParse({ ...base, seat: 0 }).success).toBe(false);
    expect(CanonicalActionRequestSchema.safeParse({ ...base, type: "CALL" }).success).toBe(false);
    expect(
      CanonicalActionRequestSchema.safeParse({ ...base, idempotencyKey: "x".repeat(129) }).success
    ).toBe(false);
  });
});
