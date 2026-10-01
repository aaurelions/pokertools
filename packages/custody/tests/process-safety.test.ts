import { describe, expect, it } from "vitest";
import { assertCustodyProcessSafety } from "../src/safety.js";

describe("custody production gate", () => {
  it("blocks production before signing infrastructure is initialized", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "production" })).toThrow(
      "ARCHITECTURE_CONVERGENCE_INCOMPLETE"
    );
  });
  it("permits isolated test execution", () => {
    expect(() => assertCustodyProcessSafety({ NODE_ENV: "test" })).not.toThrow();
  });
});
