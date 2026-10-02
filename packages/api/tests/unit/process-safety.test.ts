import { describe, expect, it } from "vitest";
import { assertPublicProcessSafety } from "../../src/safety.js";
import type { ConvergenceEvidence } from "@pokertools/types";

const VERIFIED_EVIDENCE: ConvergenceEvidence = {
  status: "PASS",
  commit: "test-commit",
  verifiedAt: "2026-01-01T00:00:00.000Z",
  results: { build: true },
};

const PENDING_EVIDENCE: ConvergenceEvidence = {
  status: "PENDING",
  commit: "",
  verifiedAt: "",
  results: {},
};

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

  it("blocks production even with an attempted configuration override", () => {
    expect(() =>
      assertPublicProcessSafety(
        {
          NODE_ENV: "production",
          ENABLE_REAL_MONEY: "true",
          POKERTOOLS_CONVERGENCE: "PASS",
        },
        PENDING_EVIDENCE
      )
    ).toThrow("ARCHITECTURE_CONVERGENCE_INCOMPLETE");
  });

  it("blocks production when evidence is unverified even with safe configuration", () => {
    expect(() => assertPublicProcessSafety(SAFE_PRODUCTION, PENDING_EVIDENCE)).toThrow(
      "ARCHITECTURE_CONVERGENCE_INCOMPLETE"
    );
  });

  it("starts production with verified evidence and safe configuration", () => {
    expect(() => assertPublicProcessSafety(SAFE_PRODUCTION, VERIFIED_EVIDENCE)).not.toThrow();
  });

  it("fails closed on verified evidence with unsafe production configuration", () => {
    expect(() =>
      assertPublicProcessSafety(
        { ...SAFE_PRODUCTION, DATABASE_URL: "file:../.runtime/dev.db" },
        VERIFIED_EVIDENCE
      )
    ).toThrow("PRODUCTION_REQUIRES_POSTGRESQL");
    expect(() =>
      assertPublicProcessSafety({ ...SAFE_PRODUCTION, JWT_SECRET: "short" }, VERIFIED_EVIDENCE)
    ).toThrow("PRODUCTION_REQUIRES_STRONG_JWT_SECRET");
    expect(() =>
      assertPublicProcessSafety({ ...SAFE_PRODUCTION, COOKIE_SECRET: "short" }, VERIFIED_EVIDENCE)
    ).toThrow("PRODUCTION_REQUIRES_STRONG_COOKIE_SECRET");
    expect(() =>
      assertPublicProcessSafety({ ...SAFE_PRODUCTION, CORS_ORIGIN: "" }, VERIFIED_EVIDENCE)
    ).toThrow("PRODUCTION_REQUIRES_CORS_ORIGIN");
    expect(() =>
      assertPublicProcessSafety({ ...SAFE_PRODUCTION, REDIS_URL: "" }, VERIFIED_EVIDENCE)
    ).toThrow("PRODUCTION_REQUIRES_REDIS_URL");
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
