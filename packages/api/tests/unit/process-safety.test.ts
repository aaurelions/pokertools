import { describe, expect, it } from "vitest";
import { assertPublicProcessSafety } from "../../src/safety.js";

const SAFE_PRODUCTION = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@db:5432/pokertools",
  REDIS_URL: "redis://:pass@redis:6379",
  JWT_SECRET: "j".repeat(48),
  COOKIE_SECRET: "c".repeat(48),
  CORS_ORIGIN: "https://app.example.com",
};

describe("public process safety", () => {
  it.each(["development", "test"])("allows isolated %s processes", (NODE_ENV) => {
    expect(() => assertPublicProcessSafety({ NODE_ENV })).not.toThrow();
  });
  it("admits production startup with safe configuration", () => {
    expect(() => assertPublicProcessSafety(SAFE_PRODUCTION)).not.toThrow();
  });
  it("does not permit a financial flag to bypass required configuration", () => {
    expect(() =>
      assertPublicProcessSafety({ NODE_ENV: "production", ENABLE_REAL_MONEY: "true" })
    ).toThrow("PRODUCTION_REQUIRES_POSTGRESQL");
  });
  it.each([
    ["DATABASE_URL", "file:../.runtime/dev.db", "PRODUCTION_REQUIRES_POSTGRESQL"],
    ["JWT_SECRET", "short", "PRODUCTION_REQUIRES_STRONG_JWT_SECRET"],
    ["COOKIE_SECRET", "short", "PRODUCTION_REQUIRES_STRONG_COOKIE_SECRET"],
    ["CORS_ORIGIN", "", "PRODUCTION_REQUIRES_CORS_ORIGIN"],
    ["REDIS_URL", "", "PRODUCTION_REQUIRES_REDIS_URL"],
    ["ENABLE_TEST_ROUTES", "true", "TEST_ROUTES_NOT_ALLOWED_IN_PRODUCTION"],
  ])("rejects unsafe production %s", (name, value, code) => {
    expect(() => assertPublicProcessSafety({ ...SAFE_PRODUCTION, [name]: value })).toThrow(code);
  });
  it.each([
    "WALLET_XPRIV_ENCRYPTION_SECRET",
    "WALLET_XPRIV_ENCRYPTION_SECRET_FILE",
    "MASTER_MNEMONIC",
    "MASTER_MNEMONIC_FILE",
    "TREASURY_PRIVATE_KEY",
    "TREASURY_PRIVATE_KEY_FILE",
    "TREASURY_SIGNING_KEYS_JSON",
    "TREASURY_SIGNING_KEYS_JSON_FILE",
    "TREASURY_MNEMONIC",
    "TREASURY_XPRIV",
  ])("rejects %s without disclosing its value", (name) => {
    const secret = "sensitive-test-value";
    try {
      assertPublicProcessSafety({ NODE_ENV: "test", [name]: secret });
      expect.fail("secret was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("CUSTODY_SECRET_IN_PUBLIC_PROCESS");
      expect(String(error)).not.toContain(secret);
    }
  });
});
