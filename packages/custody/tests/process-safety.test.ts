import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCustodyProcessSafety } from "../src/safety.js";

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

describe("custody production configuration", () => {
  it("blocks unsafe production before signing infrastructure is initialized", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "production" })).toThrow(
      "CUSTODY_PRODUCTION_REQUIRES_POSTGRESQL"
    );
  });
  it("permits isolated test execution", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "test" })).not.toThrow();
  });
  it("checks production supplied by an environment file before initialization", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await expect(import("../src/config.js")).rejects.toThrow(
      "CUSTODY_PRODUCTION_REQUIRES_POSTGRESQL"
    );
  });
  it("admits production custody with safe configuration and signing keys", () => {
    expect(() => assertCustodyProcessSafety(SAFE_PRODUCTION)).not.toThrow();
  });
  it.each([
    ["", "CUSTODY_PRODUCTION_REQUIRES_SIGNING_KEYS"],
    ["{not-json", "CUSTODY_SIGNING_KEYS_INVALID"],
    ["null", "CUSTODY_SIGNING_KEYS_INVALID"],
    ["[]", "CUSTODY_SIGNING_KEYS_INVALID"],
    ["{}", "CUSTODY_PRODUCTION_REQUIRES_SIGNING_KEYS"],
    [JSON.stringify({ 31337: "0x1234" }), "CUSTODY_SIGNING_KEYS_INVALID"],
    [JSON.stringify({ 0: `0x${"a".repeat(64)}` }), "CUSTODY_SIGNING_KEYS_INVALID"],
  ])("rejects malformed or empty signer configuration", (json, code) => {
    expect(() =>
      assertCustodyProcessSafety({ ...SAFE_PRODUCTION, TREASURY_SIGNING_KEYS_JSON: json })
    ).toThrow(code);
  });
});
