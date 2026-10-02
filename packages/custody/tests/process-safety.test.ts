import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCustodyProcessSafety } from "../src/safety.js";
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
  TREASURY_SIGNING_KEYS_JSON: JSON.stringify({ 31337: `0x${"a".repeat(64)}` }),
};

vi.mock("dotenv", () => ({
  default: {
    config: () => {
      process.env.NODE_ENV = "production";
    },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("custody production gate", () => {
  it("blocks production before signing infrastructure is initialized", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "production" }, PENDING_EVIDENCE)).toThrow(
      "ARCHITECTURE_CONVERGENCE_INCOMPLETE"
    );
  });
  it("permits isolated test execution", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "test" })).not.toThrow();
  });
  it("also blocks production supplied by an environment file before loading secrets", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await expect(import("../src/config.js")).rejects.toThrow(
      /ARCHITECTURE_CONVERGENCE_INCOMPLETE|CUSTODY_PRODUCTION_REQUIRES_POSTGRESQL/
    );
  });

  it("starts production custody with verified evidence and signing keys", () => {
    expect(() => assertCustodyProcessSafety(SAFE_PRODUCTION, VERIFIED_EVIDENCE)).not.toThrow();
  });

  it("fails closed on verified evidence without production configuration", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "production" }, VERIFIED_EVIDENCE)).toThrow(
      "CUSTODY_PRODUCTION_REQUIRES_POSTGRESQL"
    );
    expect(() =>
      assertCustodyProcessSafety(
        { ...SAFE_PRODUCTION, TREASURY_SIGNING_KEYS_JSON: "" },
        VERIFIED_EVIDENCE
      )
    ).toThrow("CUSTODY_PRODUCTION_REQUIRES_SIGNING_KEYS");
    expect(() =>
      assertCustodyProcessSafety(
        { ...SAFE_PRODUCTION, TREASURY_SIGNING_KEYS_JSON: "{not-json" },
        VERIFIED_EVIDENCE
      )
    ).toThrow("CUSTODY_SIGNING_KEYS_INVALID");
    expect(() =>
      assertCustodyProcessSafety(
        { ...SAFE_PRODUCTION, TREASURY_SIGNING_KEYS_JSON: JSON.stringify({ 31337: "0x1234" }) },
        VERIFIED_EVIDENCE
      )
    ).toThrow("CUSTODY_SIGNING_KEYS_INVALID");
  });

  it("blocks production without verified evidence even with safe configuration", () => {
    expect(() => assertCustodyProcessSafety(SAFE_PRODUCTION, PENDING_EVIDENCE)).toThrow(
      "ARCHITECTURE_CONVERGENCE_INCOMPLETE"
    );
  });
});
