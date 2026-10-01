import { GameActionRequestSchema, HealthResponseSchema, ReadinessResponseSchema } from "../src";

describe("operational and action boundaries", () => {
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
  test.each(["BET", "RAISE"])("%s requires safe integer chips", (type) => {
    for (const amount of [undefined, NaN, Infinity, 1.1, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(GameActionRequestSchema.safeParse({ type, amount }).success).toBe(false);
    }
    expect(GameActionRequestSchema.safeParse({ type, amount: 50 }).success).toBe(true);
  });
  test("does not accept caller-selected seat identity or extraneous amounts", () => {
    expect(GameActionRequestSchema.safeParse({ type: "FOLD", playerId: "victim" }).success).toBe(
      false
    );
    expect(GameActionRequestSchema.safeParse({ type: "CALL", amount: 10 }).success).toBe(false);
    expect(
      GameActionRequestSchema.safeParse({ type: "FOLD", idempotencyKey: "x".repeat(129) }).success
    ).toBe(false);
  });
});
