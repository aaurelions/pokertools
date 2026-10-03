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

// ---------------------------------------------------------------------------
// Credential rotation CAS / expiry policy (unit-level, deterministic).
// ---------------------------------------------------------------------------

interface CapturedUpdate {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function futureDate(offsetMs = 3_600_000): Date {
  return new Date(Date.now() + offsetMs);
}

function managerWithTransaction(tx: object): PrincipalManager {
  return new PrincipalManager({
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient);
}

function existingCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-1",
    userId: "svc-1",
    name: "agent",
    scopes: ["table:observe", "table:act"],
    tableId: "table-1",
    seat: 3,
    revoked: false,
    keyHash: "old-digest",
    createdById: null,
    expiresAt: futureDate(),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("PrincipalManager rotation compare-and-swap", () => {
  it("CASes rotateServiceCredential on the stored digest and revoked=false", async () => {
    let captured: CapturedUpdate | undefined;
    let reads = 0;
    const tx = {
      serviceCredential: {
        findUnique: async () => (++reads === 1 ? existingCredential() : existingCredential()),
        update: async (args: CapturedUpdate) => {
          captured = args;
          throw Object.assign(new Error("Record not found"), { code: "P2025" });
        },
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    await expect(manager.rotateServiceCredential("cred-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_CREDENTIAL_ROTATION_CONFLICT",
    });
    expect(captured?.where).toEqual({
      id: "cred-1",
      keyHash: "old-digest",
      revoked: false,
    });
  });

  it("reports a concurrent revoke as revoked instead of a generic conflict", async () => {
    let reads = 0;
    const tx = {
      serviceCredential: {
        findUnique: async () =>
          ++reads === 1 ? existingCredential() : existingCredential({ revoked: true }),
        update: async () => {
          throw Object.assign(new Error("Record not found"), { code: "P2025" });
        },
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    await expect(manager.rotateServiceCredential("cred-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_CREDENTIAL_REVOKED",
    });
  });

  it("rotation preserves identity and restrictions and only re-keys/expires", async () => {
    const existing = existingCredential();
    let captured: CapturedUpdate | undefined;
    const tx = {
      serviceCredential: {
        findUnique: async () => existing,
        update: async (args: CapturedUpdate) => {
          captured = args;
          return {
            ...existing,
            keyHash: args.data?.keyHash,
            expiresAt: args.data?.expiresAt,
          };
        },
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);
    const expiresAt = futureDate(7_200_000);

    const rotated = await manager.rotateServiceCredential("cred-1", { expiresAt });
    expect(rotated).not.toBeNull();
    expect(rotated!.id).toBe(existing.id);
    expect(rotated!.userId).toBe(existing.userId);
    expect(rotated!.scopes).toEqual(existing.scopes);
    expect(rotated!.tableId).toBe(existing.tableId);
    expect(rotated!.seat).toBe(existing.seat);
    expect(rotated!.expiresAt).toEqual(expiresAt);
    expect(captured?.data?.keyHash).toBe(hashServiceToken(rotated!.token));
    expect(captured?.data?.keyHash).not.toBe("old-digest");
    // Restrictions are never part of the rotation update.
    expect(captured?.data && "seat" in captured.data).toBe(false);
    expect(captured?.data && "tableId" in captured.data).toBe(false);
    expect(captured?.data && "scopes" in captured.data).toBe(false);
  });

  it("scoped rotation keeps the existing seat when seat is omitted or null", async () => {
    const existing = existingCredential({ name: "old-name" });
    let captured: CapturedUpdate | undefined;
    const tx = {
      user: {
        findUnique: async () => ({ id: "svc-1", kind: "SERVICE" }),
      },
      serviceCredential: {
        findUnique: async () => existing,
        update: async (args: CapturedUpdate) => {
          captured = args;
          return {
            ...existing,
            keyHash: args.data?.keyHash,
            name: args.data?.name,
            scopes: args.data?.scopes,
            seat: args.data?.seat,
            expiresAt: args.data?.expiresAt,
          };
        },
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    const omitted = await manager.issueScopedCredential({
      principalId: "svc-1",
      tableId: "table-1",
      name: "rotated",
      scopes: ["table:observe", "table:act"],
      credentialId: "cred-1",
    });
    expect(omitted.seat).toBe(3);
    expect(captured?.data?.seat).toBe(3);
    expect(captured?.where).toEqual({
      id: "cred-1",
      keyHash: "old-digest",
      revoked: false,
    });
    // tableId is never rewritten by rotation.
    expect(captured?.data && "tableId" in captured.data).toBe(false);

    captured = undefined;
    const nullSeat = await manager.issueScopedCredential({
      principalId: "svc-1",
      tableId: "table-1",
      name: "rotated",
      scopes: ["table:observe", "table:act"],
      seat: null,
      credentialId: "cred-1",
    });
    expect(nullSeat.seat).toBe(3);
    expect(captured?.data?.seat).toBe(3);

    captured = undefined;
    const narrowed = await manager.issueScopedCredential({
      principalId: "svc-1",
      tableId: "table-1",
      name: "rotated",
      scopes: ["table:observe", "table:act"],
      seat: 5,
      credentialId: "cred-1",
    });
    expect(narrowed.seat).toBe(5);
    expect(captured?.data?.seat).toBe(5);
  });

  it("maps a scoped-rotation CAS loss to 409", async () => {
    const existing = existingCredential();
    let captured: CapturedUpdate | undefined;
    let reads = 0;
    const tx = {
      user: {
        findUnique: async () => ({ id: "svc-1", kind: "SERVICE" }),
      },
      serviceCredential: {
        findUnique: async () => (++reads === 1 ? existing : existing),
        update: async (args: CapturedUpdate) => {
          captured = args;
          throw Object.assign(new Error("Record not found"), { code: "P2025" });
        },
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    await expect(
      manager.issueScopedCredential({
        principalId: "svc-1",
        tableId: "table-1",
        name: "rotated",
        scopes: ["table:observe"],
        credentialId: "cred-1",
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_CREDENTIAL_ROTATION_CONFLICT",
    });
    expect(captured?.where).toEqual({
      id: "cred-1",
      keyHash: "old-digest",
      revoked: false,
    });
  });
});

describe("PrincipalManager resource-bound table credentials", () => {
  const neverTouched = new PrincipalManager({} as PrismaClient);

  it("rejects minting an unbound table credential before any mutation", async () => {
    await expect(
      neverTouched.createServiceCredential({ name: "unbound", scopes: ["table:observe"] })
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_CREDENTIAL_TABLE_REQUIRED" });
    await expect(
      neverTouched.createServiceCredential({
        name: "unbound-empty",
        scopes: ["table:act"],
        tableId: "",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_CREDENTIAL_TABLE_REQUIRED" });

    // Orchestration remains the only unrestricted shape and still validates.
    const orchestrationTx = {
      user: {
        findUnique: async () => null,
        create: async () => ({ id: "svc-new" }),
      },
      serviceCredential: {
        create: async (args: { data: Record<string, unknown> }) => ({
          id: "cred-orch",
          userId: "svc-new",
          name: args.data.name,
          scopes: args.data.scopes,
          tableId: args.data.tableId,
          seat: args.data.seat,
          expiresAt: args.data.expiresAt,
          revoked: false,
        }),
      },
      auditLog: { create: async () => undefined },
    };
    const orchestration = await managerWithTransaction(orchestrationTx).createServiceCredential({
      name: "orchestrator",
      scopes: ["competition:orchestrate"],
    });
    expect(orchestration.scopes).toEqual(["competition:orchestrate"]);
    expect(orchestration.tableId).toBeNull();
  });

  it("fails authentication closed for unbound or mixed legacy credentials", async () => {
    const token = generateServiceToken();
    const legacyRow = (overrides: Record<string, unknown>) => ({
      id: "cred-legacy",
      userId: "svc-1",
      name: "legacy",
      scopes: ["table:observe"],
      tableId: null,
      seat: null,
      revoked: false,
      keyHash: hashServiceToken(token),
      createdById: null,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: "svc-1", address: null, role: "PLAYER", kind: "SERVICE" },
      ...overrides,
    });

    const unbound = new PrincipalManager({
      serviceCredential: { findUnique: async () => legacyRow({}) },
    } as unknown as PrismaClient);
    await expect(unbound.authenticateServiceToken(token)).resolves.toBeNull();

    const mixed = new PrincipalManager({
      serviceCredential: {
        findUnique: async () => legacyRow({ scopes: ["table:observe", "competition:orchestrate"] }),
      },
    } as unknown as PrismaClient);
    await expect(mixed.authenticateServiceToken(token)).resolves.toBeNull();

    const orchestration = new PrincipalManager({
      serviceCredential: {
        findUnique: async () => legacyRow({ scopes: ["competition:orchestrate"], tableId: null }),
      },
    } as unknown as PrismaClient);
    const principal = await orchestration.authenticateServiceToken(token, { touch: false });
    expect(principal).not.toBeNull();
    expect(principal!.scopes).toEqual(["competition:orchestrate"]);
    expect(principal!.restrictions).toEqual({ tableId: null, seat: null });
  });

  it("denies an unbound SERVICE principal outright, including replay", async () => {
    const unbound = servicePrincipal({
      restrictions: { tableId: null, seat: null },
      scopes: ["table:act"],
    });
    expect(manager.authorizeTable(unbound, "table:act", "table-1", 0)).toEqual({
      allowed: false,
      reason: "TABLE_RESTRICTED",
    });

    // The replay fallback only applies to a seat restriction; an unbound table
    // grant is rejected before any stored-receipt lookup.
    const managerWithoutDb = new PrincipalManager({} as PrismaClient);
    await expect(
      managerWithoutDb.authorizeTableRequest({
        principal: unbound,
        scope: "table:act",
        tableId: "table-1",
        persistedSeat: null,
        canonicalAction: {
          requestId: "req-1",
          turnId: "turn-1",
          expectedVersion: 1,
          actionId: "action-1",
        },
      })
    ).resolves.toEqual({ allowed: false, reason: "TABLE_RESTRICTED" });
  });
});

describe("PrincipalManager credential expiry policy", () => {
  const neverTouched = new PrincipalManager({} as PrismaClient);

  it("rejects a born-expired expiry before any mutation on every mint path", async () => {
    const past = new Date(Date.now() - 1000);
    const invalid = new Date(Number.NaN);

    await expect(
      neverTouched.createServiceCredential({
        name: "expired",
        scopes: ["table:observe"],
        tableId: "table-1",
        expiresAt: past,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_CREDENTIAL_EXPIRY_INVALID" });

    await expect(
      neverTouched.rotateServiceCredential("cred-1", { expiresAt: past })
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_CREDENTIAL_EXPIRY_INVALID" });

    await expect(
      neverTouched.rotateServiceCredential("cred-1", { expiresAt: invalid })
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_CREDENTIAL_EXPIRY_INVALID" });

    await expect(
      neverTouched.issueScopedCredential({
        principalId: "svc-1",
        tableId: "table-1",
        name: "expired",
        scopes: ["table:observe"],
        expiresAt: past,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_CREDENTIAL_EXPIRY_INVALID" });
  });

  it("requires a future expiry to rotate an already-expired credential", async () => {
    const tx = {
      serviceCredential: {
        findUnique: async () => existingCredential({ expiresAt: new Date(Date.now() - 60_000) }),
        update: async () => {
          throw new Error("must not mutate an expired credential without a new expiry");
        },
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    await expect(manager.rotateServiceCredential("cred-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_CREDENTIAL_EXPIRED",
    });
  });
});

describe("PrincipalManager provisioning races", () => {
  it("maps a duplicate-name unique violation to 409 SERVICE_PRINCIPAL_NAME_TAKEN", async () => {
    const tx = {
      user: {
        findUnique: async () => null,
        create: async () => {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        },
      },
      servicePrincipalDelegation: { create: async () => undefined },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    await expect(
      manager.provisionServicePrincipal({ name: "duplicate-agent" })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SERVICE_PRINCIPAL_NAME_TAKEN",
    });
  });

  it("revokes with a single CAS transition and stays idempotent", async () => {
    const audits: unknown[] = [];
    let revokes = 0;
    const tx = {
      serviceCredential: {
        updateMany: async () => ({ count: ++revokes === 1 ? 1 : 0 }),
        findUnique: async () => ({ id: "cred-1" }),
      },
      auditLog: {
        create: async (args: unknown) => {
          audits.push(args);
        },
      },
    };
    const manager = managerWithTransaction(tx);

    await expect(manager.revokeServiceCredential("cred-1", { actorId: "admin" })).resolves.toBe(
      true
    );
    await expect(manager.revokeServiceCredential("cred-1", { actorId: "admin" })).resolves.toBe(
      true
    );
    expect(audits).toHaveLength(1);
  });
});

describe("PrincipalManager delegation revocation", () => {
  it("transitions revokedAt exactly once and replays the original revocation", async () => {
    const audits: unknown[] = [];
    let transitions = 0;
    const row: {
      servicePrincipalId: string;
      delegatePrincipalId: string;
      revokedAt: Date | null;
    } = {
      servicePrincipalId: "svc-1",
      delegatePrincipalId: "orch-1",
      revokedAt: null,
    };
    const tx = {
      servicePrincipalDelegation: {
        findUnique: async () => ({ ...row }),
        updateMany: async (args: { data: { revokedAt: Date } }) => {
          transitions += 1;
          row.revokedAt = args.data.revokedAt;
          return { count: 1 };
        },
      },
      auditLog: {
        create: async (args: unknown) => {
          audits.push(args);
        },
      },
    };
    const manager = managerWithTransaction(tx);

    const first = await manager.revokeServicePrincipalDelegation("svc-1", { actorId: "admin" });
    expect(first).toMatchObject({
      servicePrincipalId: "svc-1",
      delegatePrincipalId: "orch-1",
      alreadyRevoked: false,
    });
    expect(first!.revokedAt).toBeInstanceOf(Date);

    // Idempotent replay: no second transition, no second audit, same timestamp.
    const second = await manager.revokeServicePrincipalDelegation("svc-1", { actorId: "admin" });
    expect(second).toMatchObject({ alreadyRevoked: true });
    expect(second!.revokedAt.toISOString()).toBe(first!.revokedAt.toISOString());
    expect(transitions).toBe(1);
    expect(audits).toHaveLength(1);
  });

  it("returns null when the principal has no delegation", async () => {
    const tx = {
      servicePrincipalDelegation: {
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    await expect(manager.revokeServicePrincipalDelegation("svc-missing")).resolves.toBeNull();
  });

  it("replays the winner when a concurrent revoke loses the CAS", async () => {
    let reads = 0;
    const winnerTime = new Date("2031-02-03T00:00:00.000Z");
    const tx = {
      servicePrincipalDelegation: {
        findUnique: async () =>
          ++reads === 1
            ? { servicePrincipalId: "svc-1", delegatePrincipalId: "orch-1", revokedAt: null }
            : { servicePrincipalId: "svc-1", delegatePrincipalId: "orch-1", revokedAt: winnerTime },
        updateMany: async () => ({ count: 0 }),
      },
      auditLog: { create: async () => undefined },
    };
    const manager = managerWithTransaction(tx);

    const result = await manager.revokeServicePrincipalDelegation("svc-1");
    expect(result).toMatchObject({ alreadyRevoked: true, revokedAt: winnerTime });
  });
});
