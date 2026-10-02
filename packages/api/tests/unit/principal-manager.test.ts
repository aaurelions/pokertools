import { describe, it, expect } from "vitest";
import {
  PrincipalManager,
  generateServiceToken,
  hashServiceToken,
  isServiceToken,
  SERVICE_TOKEN_PREFIX,
  type AuthenticatedPrincipal,
} from "../../src/services/principal-manager.js";
import type { PrismaClient } from "../../../generated/prisma/index.js";

const manager = new PrincipalManager({} as PrismaClient);

function servicePrincipal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    id: "svc-user",
    kind: "SERVICE",
    walletAddress: null,
    role: null,
    scopes: ["table:act"],
    restrictions: { tableId: "table-1", seat: 2 },
    isOperator: false,
    credentialId: "cred-1",
    ...overrides,
  };
}

describe("PrincipalManager service tokens", () => {
  it("generates prefixed 256-bit credentials and hashes without storing plaintext", () => {
    const token = generateServiceToken();
    expect(token.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
    // prefix + 43 base64url chars for 32 bytes.
    expect(token).toMatch(/^ptsvc_[A-Za-z0-9_-]{43}$/);
    expect(isServiceToken(token)).toBe(true);
    expect(isServiceToken("not-a-service-token")).toBe(false);

    const hash = hashServiceToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashServiceToken(token));
    expect(hash).not.toBe(hashServiceToken(generateServiceToken()));
  });
});

describe("PrincipalManager.authorizeTable", () => {
  it("denies a missing principal", () => {
    expect(manager.authorizeTable(undefined, "table:observe", "table-1")).toEqual({
      allowed: false,
      reason: "NO_PRINCIPAL",
    });
  });

  it("denies scope escalation", () => {
    const principal = servicePrincipal({ scopes: ["table:observe"] });
    expect(manager.authorizeTable(principal, "table:act", "table-1")).toEqual({
      allowed: false,
      reason: "SCOPE_MISSING",
    });
  });

  it("treats table:act as implying table:observe", () => {
    const principal = servicePrincipal({ scopes: ["table:act"] });
    expect(manager.authorizeTable(principal, "table:observe", "table-1", 2)).toEqual({
      allowed: true,
      reason: "OK",
    });
  });

  it("denies a resource outside the table restriction", () => {
    const principal = servicePrincipal();
    expect(manager.authorizeTable(principal, "table:act", "table-2", 2)).toEqual({
      allowed: false,
      reason: "TABLE_RESTRICTED",
    });
    expect(manager.authorizeTable(principal, "table:act", null)).toEqual({
      allowed: false,
      reason: "TABLE_RESTRICTED",
    });
  });

  it("fails closed when a seat restriction has no persisted seat", () => {
    const principal = servicePrincipal();
    expect(manager.authorizeTable(principal, "table:act", "table-1")).toEqual({
      allowed: false,
      reason: "SEAT_RESTRICTED",
    });
    expect(manager.authorizeTable(principal, "table:act", "table-1", null)).toEqual({
      allowed: false,
      reason: "SEAT_RESTRICTED",
    });
  });

  it("denies wrong-seat usage and allows only the persisted bound seat", () => {
    const principal = servicePrincipal();
    expect(manager.authorizeTable(principal, "table:act", "table-1", 3)).toEqual({
      allowed: false,
      reason: "SEAT_RESTRICTED",
    });
    expect(manager.authorizeTable(principal, "table:act", "table-1", 2)).toEqual({
      allowed: true,
      reason: "OK",
    });
  });

  it("ignores a caller-supplied seat when the credential has no seat restriction", () => {
    const principal = servicePrincipal({ restrictions: { tableId: "table-1", seat: null } });
    // A persisted seat that differs from an attacker hint is irrelevant.
    expect(manager.authorizeTable(principal, "table:act", "table-1", 7)).toEqual({
      allowed: true,
      reason: "OK",
    });
  });
});

describe("PrincipalManager.buildWalletPrincipal", () => {
  it("grants wallet principals full gameplay scopes but no operator authority", () => {
    const player = manager.buildWalletPrincipal({
      id: "wallet-1",
      address: "0xabc",
      role: "PLAYER",
    });
    expect(player).not.toBeNull();
    expect(player!.kind).toBe("WALLET");
    expect(player!.walletAddress).toBe("0xabc");
    expect(player!.isOperator).toBe(false);
    for (const scope of ["table:observe", "table:act", "table:chat"] as const) {
      expect(manager.authorizeTable(player, scope, "any-table").allowed).toBe(true);
    }

    const admin = manager.buildWalletPrincipal({
      id: "wallet-2",
      address: "0xdef",
      role: "ADMIN",
    });
    expect(admin!.isOperator).toBe(true);
  });

  it("refuses to manufacture a wallet principal for a SERVICE or addressless identity", () => {
    expect(
      manager.buildWalletPrincipal({ id: "svc", address: null, role: "PLAYER", kind: "SERVICE" })
    ).toBeNull();
    expect(
      manager.buildWalletPrincipal({ id: "svc", address: "0xabc", role: "PLAYER", kind: "SERVICE" })
    ).toBeNull();
    expect(
      manager.buildWalletPrincipal({ id: "wallet", address: null, role: "PLAYER", kind: "WALLET" })
    ).toBeNull();
  });
});
