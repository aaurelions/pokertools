import { describe, expect, it } from "vitest";
import { assertPublicProcessSafety } from "../../src/safety.js";

describe("public process safety", () => {
  it.each(["development", "test"])("allows isolated %s processes", (NODE_ENV) => {
    expect(() => assertPublicProcessSafety({ NODE_ENV })).not.toThrow();
  });

  it("blocks production even with an attempted configuration override", () => {
    expect(() =>
      assertPublicProcessSafety({
        NODE_ENV: "production",
        ENABLE_REAL_MONEY: "true",
        POKERTOOLS_CONVERGENCE: "PASS",
      })
    ).toThrow("ARCHITECTURE_CONVERGENCE_INCOMPLETE");
  });

  it.each([
    "WALLET_XPRIV_ENCRYPTION_SECRET",
    "WALLET_XPRIV_ENCRYPTION_SECRET_FILE",
    "MASTER_MNEMONIC",
    "MASTER_MNEMONIC_FILE",
    "TREASURY_PRIVATE_KEY",
    "TREASURY_PRIVATE_KEY_FILE",
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
