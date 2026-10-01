import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCustodyProcessSafety } from "../src/safety.js";

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
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "production" })).toThrow(
      "ARCHITECTURE_CONVERGENCE_INCOMPLETE"
    );
  });
  it("permits isolated test execution", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "test" })).not.toThrow();
  });
  it("also blocks production supplied by an environment file before loading secrets", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await expect(import("../src/config.js")).rejects.toThrow("ARCHITECTURE_CONVERGENCE_INCOMPLETE");
  });
});
