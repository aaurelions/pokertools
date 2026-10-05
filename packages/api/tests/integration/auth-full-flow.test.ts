/// <reference path="../../types/fastify.d.ts" />
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { ChipLedger } from "../../src/services/chip-ledger.js";

/**
 * Hold every `chipAccount.upsert` until `expected` calls have arrived and the
 * test releases the gate. Test-only instrumentation: the production bootstrap
 * path is untouched.
 *
 * SQLite interactive transactions are serialized by the single-writer adapter
 * (a second `$transaction` callback cannot start before the first commits), so
 * this gates concurrent direct `ensureAccount` calls, which is where SQLite
 * can still interleave callers before the driver serializes the writes.
 */
function gateAccountUpserts(
  app: FastifyInstance,
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

  const original = app.prisma.chipAccount.upsert.bind(app.prisma.chipAccount) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const spy = vi.spyOn(app.prisma.chipAccount, "upsert").mockImplementation(((
    ...args: unknown[]
  ) => {
    arrivals += 1;
    if (arrivals >= expected) markArrived();
    return released.then(() => original(...args));
  }) as never);

  return { arrived, release, restore: () => spy.mockRestore() };
}

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

describe("Auth - Full SIWE Flow Integration Test", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signedMessageForFreshNonce(
    account: PrivateKeyAccount
  ): Promise<{ message: string; signature: string; nonce: string }> {
    const nonceRes = await app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = JSON.parse(nonceRes.body) as { nonce: string };
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: "localhost",
      nonce,
      uri: "http://localhost",
      version: "1",
    });
    return { message, signature: await account.signMessage({ message }), nonce };
  }

  it("should successfully login with a valid SIWE signature", async () => {
    // 1. Generate a random wallet
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    console.log(`🔐 Generated test wallet: ${address}`);

    // 2. Request Nonce
    const nonceRes = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address },
    });

    expect(nonceRes.statusCode).toBe(200);
    const { nonce } = JSON.parse(nonceRes.body);
    expect(nonce).toBeTruthy();

    // 3. Create SIWE Message
    // Note: viem/siwe createSiweMessage expects specific parameters to match the verification
    const message = createSiweMessage({
      address,
      chainId: 1, // Mainnet
      domain: "localhost", // Fastify usually defaults to localhost or configured domain
      nonce,
      uri: "http://localhost", // Origin
      version: "1",
      statement: "Sign in to PokerTools",
    });

    // 4. Sign Message
    const signature = await account.signMessage({
      message,
    });

    // 5. Login
    // Ensure the URL is exactly as registered
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        message,
        signature,
      },
    });

    if (loginRes.statusCode !== 200) {
      console.error("Login failed:", loginRes.body);
    }

    expect(loginRes.statusCode).toBe(200);
    const body = JSON.parse(loginRes.body);

    expect(body.token).toBeTruthy();
    expect(body.user).toBeTruthy();
    expect(body.user.username).toContain("player_");

    // Verify token works
    const meRes = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: {
        authorization: `Bearer ${body.token}`,
      },
    });

    expect(meRes.statusCode).toBe(200);
    const me = JSON.parse(meRes.body);
    expect(me.address.toLowerCase()).toBe(address.toLowerCase());
  });

  it("should fail with manipulated message", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    const nonceRes = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address },
    });
    const { nonce } = JSON.parse(nonceRes.body);

    const message = createSiweMessage({
      address,
      chainId: 1,
      domain: "localhost",
      nonce,
      uri: "http://localhost",
      version: "1",
      statement: "Sign in to PokerTools",
    });

    // Sign the original message
    const signature = await account.signMessage({ message });

    // Tamper with the message
    const tamperedMessage = message.replace(nonce, "invalidnonce");

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        message: tamperedMessage,
        signature,
      },
    });

    expect(loginRes.statusCode).toBe(401); // Either nonce check or signature verification will fail
  });

  it("defaults to an opaque, non-wallet-derived username", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, signature } = await signedMessageForFreshNonce(account);

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message, signature },
    });
    expect(loginRes.statusCode).toBe(200);
    const body = JSON.parse(loginRes.body) as { user: { id: string; username: string } };

    // 128-bit CSPRNG default with a display-only prefix: no wallet-derived
    // substring can leak through public projections (e.g. tournament entries).
    expect(body.user.username).toMatch(/^player_[0-9a-f]{32}$/);
    const addressLower = account.address.toLowerCase();
    expect(body.user.username).not.toContain(addressLower.slice(2, 14));
    expect(body.user.username).not.toContain(addressLower);

    const row = await app.prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(row.username).toBe(body.user.username);
    expect(row.address).toBe(addressLower);
  });

  it("converges concurrent first logins for the same wallet on one principal", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const [first, second] = await Promise.all([
      signedMessageForFreshNonce(account),
      signedMessageForFreshNonce(account),
    ]);

    const [loginA, loginB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { message: first.message, signature: first.signature },
      }),
      app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { message: second.message, signature: second.signature },
      }),
    ]);

    expect(loginA.statusCode).toBe(200);
    expect(loginB.statusCode).toBe(200);
    const a = JSON.parse(loginA.body) as {
      token: string;
      user: { id: string; username: string };
    };
    const b = JSON.parse(loginB.body) as {
      token: string;
      user: { id: string; username: string };
    };

    // Same durable principal, same opaque default name, no duplicate row.
    expect(a.user.id).toBe(b.user.id);
    expect(a.user.username).toBe(b.user.username);
    expect(a.user.username).toMatch(/^player_[0-9a-f]{32}$/);
    const addressLower = account.address.toLowerCase();
    expect(await app.prisma.user.count({ where: { address: addressLower } })).toBe(1);

    // Exactly one AVAILABLE account for that principal, canonical owner scope,
    // untouched zero balance.
    const accounts = await app.prisma.chipAccount.findMany({ where: { principalId: a.user.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      principalId: a.user.id,
      kind: "AVAILABLE",
      scopeKey: "@owner",
      balance: 0n,
    });

    // Both issued sessions resolve to that same principal.
    for (const token of [a.token, b.token]) {
      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect((JSON.parse(me.body) as { id: string }).id).toBe(a.user.id);
    }
  });

  it("converges gated concurrent account bootstrap on one account without touching balance/owner/scope", async () => {
    const ledger = new ChipLedger(app.prisma);
    const principalId = `sqlite-bootstrap-${randomUUID()}`;

    // Both concurrent ensures are parked before either may write; the
    // bootstrap must converge on one row and one id.
    const gate = gateAccountUpserts(app, 2);
    try {
      const racing = Promise.all([
        ledger.ensureAvailableAccount(app.prisma, principalId),
        ledger.ensureAvailableAccount(app.prisma, principalId),
      ]);
      await withTimeout(gate.arrived, 15_000, "both account bootstrap upserts");
      gate.release();
      const [first, second] = await racing;
      expect(first.id).toBe(second.id);
    } finally {
      gate.release();
      gate.restore();
    }

    const created = await app.prisma.chipAccount.findMany({ where: { principalId } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      principalId,
      kind: "AVAILABLE",
      scopeKey: "@owner",
      balance: 0n,
    });

    // Fund the account, then re-ensure under the same gate: a materialized
    // NONZERO balance and the owner/scope identity are never rewritten.
    const funded = await app.prisma.chipAccount.update({
      where: { id: created[0].id },
      data: { balance: 777n },
    });
    const gateAgain = gateAccountUpserts(app, 2);
    try {
      const racingAgain = Promise.all([
        ledger.ensureAvailableAccount(app.prisma, principalId),
        ledger.ensureAvailableAccount(app.prisma, principalId),
      ]);
      await withTimeout(gateAgain.arrived, 15_000, "both re-ensure upserts");
      gateAgain.release();
      const [first, second] = await racingAgain;
      expect(first.id).toBe(funded.id);
      expect(second.id).toBe(funded.id);
    } finally {
      gateAgain.release();
      gateAgain.restore();
    }

    const after = await app.prisma.chipAccount.findUniqueOrThrow({ where: { id: funded.id } });
    expect(after.balance).toBe(777n);
    expect(after.version).toBe(funded.version);
    expect(after.principalId).toBe(principalId);
    expect(after.kind).toBe("AVAILABLE");
    expect(after.scopeKey).toBe("@owner");
    expect(after.createdAt).toEqual(funded.createdAt);
  });

  it("consumes a nonce only when the signature is valid", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, signature, nonce } = await signedMessageForFreshNonce(account);

    // A message altered after signing fails signature verification before the
    // nonce claim; the Redis nonce is not consumed by an invalid attempt.
    const tampered = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message: message.replace(nonce, "invalidnonce"), signature },
    });
    expect(tampered.statusCode).toBe(401);

    // The original valid message still works, then is consumed exactly once.
    const valid = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message, signature },
    });
    expect(valid.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message, signature },
    });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).error).toBe("Invalid or expired nonce");
  });
});
