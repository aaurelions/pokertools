/// <reference types="vitest/globals" />
/**
 * Canonical PostgreSQL acceptance: service-credential rotation / revocation
 * races over the real loopback HTTP API.
 *
 * Reuses the shared canonical harness (real PostgreSQL + Redis + Fastify on
 * loopback) but stays self-contained: it creates no competition fixtures and
 * touches no competition acceptance file.
 *
 * The HTTP rotation race is deterministic, not timing-based: a spy on the
 * Prisma `$transaction` gates the credential CAS update so both racing
 * requests have read the same pre-rotation digest before either update is
 * released (same no-sleep window technique as the other canonical race tests).
 * Exactly one CAS can therefore win; the loser must be a 409, never a second
 * last-write-wins rotation.
 *
 * `issueScopedCredential` (the competition agent-credential path) is raced at
 * the service boundary because its HTTP route needs a competition fixture
 * owned by the competition acceptance suite; it is still exercised against
 * real PostgreSQL with the same deterministic gate.
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  apiRequest,
  bootApp,
  loginWallet,
  promoteToOperator,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { hashServiceToken, generateServiceToken } from "../../../src/services/principal-manager.js";

interface CredentialWire {
  id: string;
  userId: string;
  scopes: string[];
  tableId: string | null;
  seat: number | null;
  expiresAt: string | null;
  token: string;
}

interface ErrorWire {
  code?: string;
  error?: string;
}

type TransactionFn = (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Hold every transaction call to `model.method` until `expected` calls have
 * arrived and the test explicitly releases the gate. `arrived` resolves once
 * the barrier is full. The spy is always restored by the caller.
 */
function gateTransactionCall(
  app: FastifyInstance,
  model: string,
  method: string,
  expected: number
): { arrived: Promise<void>; release: () => void; restore: () => void } {
  let arrivals = 0;
  let release!: () => void;
  let markArrived!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    markArrived = resolve;
  });

  const original = app.prisma.$transaction.bind(app.prisma) as unknown as TransactionFn;
  const spy = vi.spyOn(app.prisma, "$transaction").mockImplementation(((
    fn: (tx: unknown) => Promise<unknown>,
    opts?: unknown
  ) =>
    original(async (tx: unknown) => {
      const wrapped = new Proxy(tx as object, {
        get(target, prop, receiver) {
          if (prop !== model) return Reflect.get(target, prop, receiver);
          const delegate = (target as Record<string, unknown>)[model] as Record<string, unknown>;
          return new Proxy(delegate, {
            get(delegateTarget, delegateProp, delegateReceiver) {
              if (delegateProp !== method) {
                return Reflect.get(delegateTarget, delegateProp, delegateReceiver);
              }
              const originalMethod = (
                delegateTarget as Record<string, (...args: unknown[]) => Promise<unknown>>
              )[method];
              return async (...args: unknown[]) => {
                arrivals += 1;
                if (arrivals >= expected) markArrived();
                await released;
                return originalMethod.apply(delegateTarget, args);
              };
            },
          });
        },
      });
      return fn(wrapped);
    }, opts)) as never);

  return { arrived, release, restore: () => spy.mockRestore() };
}

describe("service credential rotation/revocation race acceptance (PostgreSQL + HTTP)", () => {
  let booted: AcceptanceApp;
  let operator: WalletPrincipal;
  const credentialIds: string[] = [];
  const serviceUserIds: string[] = [];

  async function createCredential(
    overrides: { tableId?: string; seat?: number; expiresAt?: string } = {}
  ): Promise<CredentialWire> {
    const response = await apiRequest<CredentialWire & ErrorWire>(
      booted.baseUrl,
      "POST",
      "/auth/service-credentials",
      {
        token: operator.token,
        body: {
          name: `race-${crypto.randomBytes(4).toString("hex")}`,
          scopes: ["table:observe", "table:act", "table:chat"],
          // Every SERVICE table credential is resource-bound; these race tests
          // need no real table row (tableId is an opaque binding).
          tableId: `race-table-${crypto.randomBytes(3).toString("hex")}`,
          ...overrides,
        },
      }
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    credentialIds.push(response.body.id);
    serviceUserIds.push(response.body.userId);
    return response.body;
  }

  function rotate(
    credentialId: string,
    body: Record<string, unknown> = {}
  ): Promise<{ status: number; body: CredentialWire & ErrorWire }> {
    return apiRequest(booted.baseUrl, "POST", `/auth/service-credentials/${credentialId}/rotate`, {
      token: operator.token,
      body,
    });
  }

  function revoke(credentialId: string): Promise<{ status: number; body: unknown }> {
    return apiRequest(booted.baseUrl, "POST", `/auth/service-credentials/${credentialId}/revoke`, {
      token: operator.token,
    });
  }

  function authenticate(token: string): Promise<{ status: number; body: unknown }> {
    return apiRequest(booted.baseUrl, "GET", "/auth/me", { token });
  }

  /** Build a fresh SIWE message + signature for a nonce from the real API. */
  async function signedSiweMessage(
    account: PrivateKeyAccount
  ): Promise<{ message: string; signature: string }> {
    const nonceResponse = await apiRequest<{ nonce: string }>(
      booted.baseUrl,
      "POST",
      "/auth/nonce"
    );
    expect(nonceResponse.status, JSON.stringify(nonceResponse.body)).toBe(200);
    const message = createSiweMessage({
      address: account.address,
      chainId: 31337,
      domain: new URL(booted.baseUrl).hostname,
      uri: booted.baseUrl,
      nonce: nonceResponse.body.nonce,
      version: "1",
      issuedAt: new Date(),
    });
    return { message, signature: await account.signMessage({ message }) };
  }

  beforeAll(async () => {
    booted = await bootApp();
    operator = await loginWallet(booted.baseUrl);
    await promoteToOperator(booted.app, operator.id);
  });

  afterAll(async () => {
    if (!booted) return;
    await booted.app.prisma.serviceCredential
      .deleteMany({ where: { id: { in: credentialIds } } })
      .catch(() => undefined);
    await booted.app.prisma.serviceCredential
      .deleteMany({ where: { userId: { in: serviceUserIds } } })
      .catch(() => undefined);
    await booted.app.prisma.user
      .deleteMany({ where: { id: { in: serviceUserIds } } })
      .catch(() => undefined);
    await booted.close();
  });

  it("lets exactly one of two concurrent HTTP rotations win; the loser gets 409", async () => {
    const created = await createCredential();
    const gate = gateTransactionCall(booted.app, "serviceCredential", "update", 2);
    try {
      const first = rotate(created.id);
      const second = rotate(created.id);
      // Both requests have read the same pre-rotation digest and are parked on
      // their CAS update; release them to race the actual row write.
      await withTimeout(gate.arrived, 15_000, "both rotation CAS updates");
      gate.release();
      const [a, b] = await Promise.all([first, second]);

      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.error).toBe("SERVICE_CREDENTIAL_ROTATION_CONFLICT");
      const winner = a.status === 200 ? a : b;

      // The pre-rotation secret is dead; only the winner's secret persists.
      expect((await authenticate(created.token)).status).toBe(401);
      expect((await authenticate(winner.body.token)).status).toBe(200);
      const row = await booted.app.prisma.serviceCredential.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.keyHash).toBe(hashServiceToken(winner.body.token));
      expect(row.revoked).toBe(false);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  it("cannot revive a revoked credential when rotate races revoke", async () => {
    const created = await createCredential();
    const gate = gateTransactionCall(booted.app, "serviceCredential", "update", 1);
    try {
      const rotating = rotate(created.id);
      await withTimeout(gate.arrived, 15_000, "rotation CAS update");
      // The revoke commits while the rotation is still parked before its CAS.
      const revoked = await revoke(created.id);
      expect(revoked.status).toBe(200);
      gate.release();

      const rotated = await rotating;
      expect(rotated.status).toBe(409);
      expect(rotated.body.error).toBe("SERVICE_CREDENTIAL_REVOKED");

      const row = await booted.app.prisma.serviceCredential.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.revoked).toBe(true);
      expect(row.revokedAt).not.toBeNull();
      expect((await authenticate(created.token)).status).toBe(401);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  it("kills the rotated secret when a revoke follows a successful rotation", async () => {
    const created = await createCredential();
    const rotated = await rotate(created.id);
    expect(rotated.status).toBe(200);
    expect((await authenticate(rotated.body.token)).status).toBe(200);

    const revoked = await revoke(created.id);
    expect(revoked.status).toBe(200);
    expect((await authenticate(rotated.body.token)).status).toBe(401);
    const row = await booted.app.prisma.serviceCredential.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.revoked).toBe(true);
  });

  it("rejects a past expiry over HTTP without touching the current secret", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const name = `expired-race-${crypto.randomBytes(4).toString("hex")}`;
    const deniedCreate = await apiRequest<ErrorWire>(
      booted.baseUrl,
      "POST",
      "/auth/service-credentials",
      {
        token: operator.token,
        body: {
          name,
          scopes: ["table:observe"],
          tableId: `expiry-table-${crypto.randomBytes(3).toString("hex")}`,
          expiresAt: past,
        },
      }
    );
    expect(deniedCreate.status).toBe(400);
    expect(deniedCreate.body.error).toBe("SERVICE_CREDENTIAL_EXPIRY_INVALID");
    expect(await booted.app.prisma.serviceCredential.count({ where: { name } })).toBe(0);

    const created = await createCredential();
    const deniedRotate = await rotate(created.id, { expiresAt: past });
    expect(deniedRotate.status).toBe(400);
    expect(deniedRotate.body.error).toBe("SERVICE_CREDENTIAL_EXPIRY_INVALID");
    expect((await authenticate(created.token)).status).toBe(200);
  });

  it("maps a concurrent duplicate service-principal name to 409, never 500", async () => {
    const name = `name-race-${crypto.randomBytes(4).toString("hex")}`;
    const provision = () =>
      apiRequest<{ principalId: string } & ErrorWire>(
        booted.baseUrl,
        "POST",
        "/auth/service-principals",
        { token: operator.token, body: { name } }
      );

    // Park both inserts after their (empty) name pre-check so both reach the
    // unique index: one commits, the other must be mapped from P2002 to 409.
    const gate = gateTransactionCall(booted.app, "user", "create", 2);
    try {
      const first = provision();
      const second = provision();
      await withTimeout(gate.arrived, 15_000, "both principal inserts");
      gate.release();
      const [a, b] = await Promise.all([first, second]);

      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.error).toBe("SERVICE_PRINCIPAL_NAME_TAKEN");
      const winner = a.status === 201 ? a : b;
      serviceUserIds.push(winner.body.principalId);
      expect(await booted.app.prisma.user.count({ where: { username: name } })).toBe(1);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  it("lets exactly one scoped-credential rotation win and preserves the seat", async () => {
    const tableId = `scoped-table-${crypto.randomBytes(4).toString("hex")}`;
    const created = await createCredential({ tableId, seat: 4 });
    const manager = booted.app.principalManager;
    const rotateScoped = () =>
      manager.issueScopedCredential({
        principalId: created.userId,
        tableId,
        name: "scoped-rotated",
        scopes: ["table:observe", "table:act"],
        credentialId: created.id,
      });

    const gate = gateTransactionCall(booted.app, "serviceCredential", "update", 2);
    try {
      const first = rotateScoped();
      const second = rotateScoped();
      await withTimeout(gate.arrived, 15_000, "both scoped rotation CAS updates");
      gate.release();
      const settled = await Promise.allSettled([first, second]);

      const fulfilled = settled.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof rotateScoped>>> =>
          result.status === "fulfilled"
      );
      const rejected = settled.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        statusCode: 409,
        code: "SERVICE_CREDENTIAL_ROTATION_CONFLICT",
      });

      const winner = fulfilled[0].value;
      expect(winner.seat).toBe(4);
      expect(winner.tableId).toBe(tableId);
      expect((await authenticate(winner.token)).status).toBe(200);
      expect((await authenticate(created.token)).status).toBe(401);
      const row = await booted.app.prisma.serviceCredential.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.keyHash).toBe(hashServiceToken(winner.token));
      expect(row.seat).toBe(4);
      expect(row.tableId).toBe(tableId);
      expect(row.revoked).toBe(false);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  it("revokes a delegation over HTTP durably and idempotently without touching issued credentials", async () => {
    const name = `delegated-${crypto.randomBytes(4).toString("hex")}`;
    const provisioned = await apiRequest<{ principalId: string } & ErrorWire>(
      booted.baseUrl,
      "POST",
      "/auth/service-principals",
      { token: operator.token, body: { name, delegatedToPrincipalId: operator.id } }
    );
    expect(provisioned.status, JSON.stringify(provisioned.body)).toBe(201);
    const principalId = provisioned.body.principalId;
    serviceUserIds.push(principalId);

    expect(
      await booted.app.principalManager.isServicePrincipalDelegatedTo(principalId, operator.id)
    ).toBe(true);

    const credentialResponse = await apiRequest<CredentialWire & ErrorWire>(
      booted.baseUrl,
      "POST",
      "/auth/service-credentials",
      {
        token: operator.token,
        body: {
          principalId,
          name: `${name}-room`,
          scopes: ["table:observe"],
          tableId: `delegation-room-${crypto.randomBytes(3).toString("hex")}`,
        },
      }
    );
    expect(credentialResponse.status, JSON.stringify(credentialResponse.body)).toBe(201);
    credentialIds.push(credentialResponse.body.id);
    expect((await authenticate(credentialResponse.body.token)).status).toBe(200);

    const revokeUrl = `/auth/service-principals/${principalId}/delegation/revoke`;
    const first = await apiRequest<
      {
        success: boolean;
        servicePrincipalId: string;
        delegatePrincipalId: string;
        revokedAt: string;
      } & ErrorWire
    >(booted.baseUrl, "POST", revokeUrl, { token: operator.token });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      servicePrincipalId: principalId,
      delegatePrincipalId: operator.id,
    });
    expect(typeof first.body.revokedAt).toBe("string");

    // Durable gate consumed by roster/credential issuance fails closed.
    expect(
      await booted.app.principalManager.isServicePrincipalDelegatedTo(principalId, operator.id)
    ).toBe(false);

    // Idempotent: same revocation time, exactly one durable audit transition.
    const second = await apiRequest<{ revokedAt: string }>(booted.baseUrl, "POST", revokeUrl, {
      token: operator.token,
    });
    expect(second.status).toBe(200);
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
    expect(
      await booted.app.prisma.auditLog.count({
        where: {
          action: "SERVICE_PRINCIPAL_DELEGATION_REVOKE",
          resource: `service-principal:${principalId}`,
        },
      })
    ).toBe(1);

    // Explicit policy: the already-issued room credential is untouched.
    expect((await authenticate(credentialResponse.body.token)).status).toBe(200);
  });

  it("restricts delegation revocation to operator wallets over real HTTP", async () => {
    const player = await loginWallet(booted.baseUrl);
    const url = `/auth/service-principals/${operator.id}/delegation/revoke`;

    const denied = await apiRequest<ErrorWire>(booted.baseUrl, "POST", url, {
      token: player.token,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("OPERATOR_REQUIRED");

    const missing = await apiRequest<ErrorWire>(
      booted.baseUrl,
      "POST",
      "/auth/service-principals/no-such-principal/delegation/revoke",
      { token: operator.token }
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("SERVICE_PRINCIPAL_DELEGATION_NOT_FOUND");

    const strict = await apiRequest<ErrorWire>(booted.baseUrl, "POST", url, {
      token: operator.token,
      body: { force: true },
    });
    expect(strict.status).toBe(400);
  });

  it("sanitizes unexpected Prisma failures over real HTTP without leaking secrets", async () => {
    const secret = "postgresql://poker:sup3r-s3cret@db.internal:5432/poker";
    const rawError = Object.assign(new Error(`driver failure while connecting to ${secret}`), {
      code: "P2010",
      meta: { driverAdapterError: secret },
    });
    const logSpy = vi.spyOn(booted.app.log, "error").mockImplementation(() => undefined);
    const failureSpy = vi
      .spyOn(booted.app.principalManager, "listServiceCredentials")
      .mockRejectedValue(rawError);
    try {
      const res = await apiRequest<ErrorWire>(booted.baseUrl, "GET", "/auth/service-credentials", {
        token: operator.token,
      });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "INTERNAL_ERROR", message: "Internal server error" });
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("P2010");
      expect(serialized).not.toContain("driver failure");

      expect(logSpy).toHaveBeenCalled();
      const logs = JSON.stringify(logSpy.mock.calls);
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain("P2010");
      expect(logs).not.toContain("driver failure");
      for (const call of logSpy.mock.calls) {
        expect(call[0]).not.toBe(rawError);
      }
    } finally {
      failureSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("converges concurrent first SIWE logins for one fresh wallet on a single principal", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const [first, second] = await Promise.all([
      signedSiweMessage(account),
      signedSiweMessage(account),
    ]);
    const [loginA, loginB] = await Promise.all([
      apiRequest<{ token: string; user: { id: string; username: string } } & ErrorWire>(
        booted.baseUrl,
        "POST",
        "/auth/login",
        { body: first }
      ),
      apiRequest<{ token: string; user: { id: string; username: string } } & ErrorWire>(
        booted.baseUrl,
        "POST",
        "/auth/login",
        { body: second }
      ),
    ]);

    expect(loginA.status, JSON.stringify(loginA.body)).toBe(200);
    expect(loginB.status, JSON.stringify(loginB.body)).toBe(200);
    expect(loginA.body.user.id).toBe(loginB.body.user.id);
    expect(loginA.body.user.username).toBe(loginB.body.user.username);

    const addressLower = account.address.toLowerCase();
    expect(await booted.app.prisma.user.count({ where: { address: addressLower } })).toBe(1);

    // The default public name is opaque CSPRNG, never a wallet-linkable prefix.
    expect(loginA.body.user.username).toMatch(/^player_[0-9a-f]{32}$/);
    expect(loginA.body.user.username).not.toContain(addressLower.slice(2, 14));

    // Both sessions resolve to the same durable principal over real HTTP.
    for (const token of [loginA.body.token, loginB.body.token]) {
      const me = await apiRequest<{ id: string }>(booted.baseUrl, "GET", "/auth/me", { token });
      expect(me.status, JSON.stringify(me.body)).toBe(200);
      expect(me.body.id).toBe(loginA.body.user.id);
    }
  });

  it("consumes a SIWE nonce only for a valid signature over real HTTP", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const nonceResponse = await apiRequest<{ nonce: string }>(
      booted.baseUrl,
      "POST",
      "/auth/nonce"
    );
    const { nonce } = nonceResponse.body;
    const message = createSiweMessage({
      address: account.address,
      chainId: 31337,
      domain: new URL(booted.baseUrl).hostname,
      uri: booted.baseUrl,
      nonce,
      version: "1",
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });

    // A tampered message fails signature verification before the nonce claim.
    const tampered = await apiRequest<ErrorWire>(booted.baseUrl, "POST", "/auth/login", {
      body: { message: message.replace(nonce, "invalidnonce"), signature },
    });
    expect(tampered.status).toBe(401);

    // The original valid message still works, then is consumed exactly once.
    const valid = await apiRequest<{ token: string }>(booted.baseUrl, "POST", "/auth/login", {
      body: { message, signature },
    });
    expect(valid.status, JSON.stringify(valid.body)).toBe(200);
    const replay = await apiRequest<ErrorWire>(booted.baseUrl, "POST", "/auth/login", {
      body: { message, signature },
    });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("Invalid or expired nonce");
  });

  it("rejects unbound table credentials over real HTTP", async () => {
    const name = `unbound-${crypto.randomBytes(4).toString("hex")}`;
    const denied = await apiRequest<ErrorWire>(
      booted.baseUrl,
      "POST",
      "/auth/service-credentials",
      {
        token: operator.token,
        body: { name, scopes: ["table:observe", "table:act"] },
      }
    );
    expect(denied.status).toBe(400);
    expect(denied.body.error).toBe("Validation failed");
    expect(await booted.app.prisma.serviceCredential.count({ where: { name } })).toBe(0);
  });

  it("enforces the durable table-binding CHECK on PostgreSQL", async () => {
    // A bound backing credential supplies a real SERVICE principal.
    const backing = await createCredential({
      tableId: `binding-table-${crypto.randomBytes(3).toString("hex")}`,
    });
    const keyHash = hashServiceToken(generateServiceToken());

    let checkError: unknown;
    try {
      await booted.app.prisma.serviceCredential.create({
        data: {
          userId: backing.userId,
          name: `check-unbound-${crypto.randomBytes(3).toString("hex")}`,
          keyHash,
          scopes: ["table:observe"],
          tableId: null,
          seat: null,
        },
      });
    } catch (error) {
      checkError = error;
    }
    expect(checkError, "active unbound table credential must be rejected by 009").toBeDefined();
    expect(String(checkError)).toMatch(/ServiceCredential_table_binding|check constraint|23514/i);
    expect(await booted.app.prisma.serviceCredential.count({ where: { keyHash } })).toBe(0);
  });

  it("keeps revoked historical unbound metadata without authority", async () => {
    const backing = await createCredential({
      tableId: `history-table-${crypto.randomBytes(3).toString("hex")}`,
    });
    const legacyToken = generateServiceToken();
    // The CHECK exempts revoked rows, so the migration's historical revocation
    // is representable: public metadata may keep the old tableId, never a grant.
    const legacy = await booted.app.prisma.serviceCredential.create({
      data: {
        userId: backing.userId,
        name: `legacy-revoked-${crypto.randomBytes(3).toString("hex")}`,
        keyHash: hashServiceToken(legacyToken),
        scopes: ["table:observe", "table:act"],
        tableId: null,
        seat: null,
        revoked: true,
        revokedAt: new Date(),
      },
    });
    credentialIds.push(legacy.id);

    expect((await authenticate(legacyToken)).status).toBe(401);
    const replay = await apiRequest<ErrorWire>(booted.baseUrl, "POST", "/tables/any-table/action", {
      token: legacyToken,
      body: {
        requestId: crypto.randomUUID(),
        turnId: "legacy-turn",
        expectedVersion: 1,
        actionId: "legacy-action",
      },
    });
    expect(replay.status).toBe(401);

    const listed = await apiRequest<{
      credentials: Array<{ id: string; tableId: string | null; revoked: boolean }>;
    }>(booted.baseUrl, "GET", "/auth/service-credentials", { token: operator.token });
    const row = listed.body.credentials.find((credential) => credential.id === legacy.id);
    expect(row?.revoked).toBe(true);
    expect(row?.tableId).toBeNull();
  });

  it("keeps orchestration credentials valid without a resource binding", async () => {
    const orchestration = await apiRequest<CredentialWire & ErrorWire>(
      booted.baseUrl,
      "POST",
      "/auth/service-credentials",
      {
        token: operator.token,
        body: {
          name: `orch-${crypto.randomBytes(4).toString("hex")}`,
          scopes: ["competition:orchestrate"],
        },
      }
    );
    expect(orchestration.status, JSON.stringify(orchestration.body)).toBe(201);
    credentialIds.push(orchestration.body.id);
    serviceUserIds.push(orchestration.body.userId);
    expect(orchestration.body.tableId).toBeNull();
    expect(orchestration.body.seat).toBeNull();
    expect((await authenticate(orchestration.body.token)).status).toBe(200);
  });
});
