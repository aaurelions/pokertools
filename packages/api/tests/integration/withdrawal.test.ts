/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  WITHDRAWAL_DOMAIN_NAME,
  WITHDRAWAL_DOMAIN_VERSION,
  WITHDRAWAL_INTENT_EIP712_FIELDS,
  WITHDRAWAL_INTENT_PRIMARY_TYPE,
  createWithdrawalDomain,
  WithdrawalRecordSchema,
} from "@pokertools/types";
import { buildApp } from "../../src/app.js";
import { AtomicLedger } from "../../src/services/atomic-ledger.js";

const CHAIN_ID = 31337;
const TREASURY = "0x00000000000000000000000000000000000000aa";
const DESTINATION = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

/**
 * Canonical withdrawal endpoint.
 *
 * The legacy `/user/withdraw` string-message flow is gone. Withdrawals are now
 * EIP-712-bound intents: every field (principal, asset, destination, amount,
 * nonce, deadline, chainId) is signed against the fixed treasury domain, and
 * the actor is derived from the authenticated wallet principal.
 */
describe("Canonical withdrawal endpoint (EIP-712)", () => {
  let app: FastifyInstance;
  let assetId: string;
  let userId: string;
  let authToken: string;

  const signer = privateKeyToAccount(generatePrivateKey());
  const walletAddress = signer.address.toLowerCase();

  const ledger = () => new AtomicLedger(app.prisma);

  function makeIntent(
    overrides: Partial<{
      intentId: string;
      principalId: string;
      assetId: string;
      destination: string;
      amountAtomic: string;
      nonce: number;
      deadline: number;
      chainId: number;
    }> = {}
  ) {
    return {
      intentId: `intent-${crypto.randomUUID()}`,
      principalId: userId,
      assetId,
      destination: DESTINATION,
      amountAtomic: "100",
      nonce: Date.now() + Math.floor(Math.random() * 100_000),
      deadline: Math.floor(Date.now() / 1000) + 600,
      chainId: CHAIN_ID,
      ...overrides,
    };
  }

  async function signIntent(
    intent: ReturnType<typeof makeIntent>,
    account: ReturnType<typeof privateKeyToAccount> = signer,
    domain = createWithdrawalDomain(CHAIN_ID, TREASURY)
  ): Promise<`0x${string}`> {
    return account.signTypedData({
      domain,
      types: { [WITHDRAWAL_INTENT_PRIMARY_TYPE]: [...WITHDRAWAL_INTENT_EIP712_FIELDS] },
      primaryType: WITHDRAWAL_INTENT_PRIMARY_TYPE,
      message: intent,
    } as never);
  }

  async function submit(intent: unknown, signature?: string) {
    return app.inject({
      method: "POST",
      url: "/finance/withdrawals/intents",
      headers: { authorization: `Bearer ${authToken}` },
      payload: signature === undefined ? { intent } : { intent, signature },
    });
  }

  async function fund(amountAtomic: string): Promise<void> {
    const chips = ledger();
    const user = await chips.ensureAccount(app.prisma, {
      assetId,
      ownerId: userId,
      class: "USER_AVAILABLE",
    });
    const treasury = await chips.ensureAccount(app.prisma, {
      assetId,
      ownerId: null,
      class: "TREASURY_RESERVE",
    });
    await chips.postAtomic({
      requestId: `fund-${crypto.randomUUID()}`,
      assetId,
      postings: [
        { accountId: treasury.accountId, amountAtomic: `-${amountAtomic}` },
        { accountId: user.accountId, amountAtomic },
      ],
    });
  }

  async function balanceClass(accountClass: "USER_AVAILABLE" | "PENDING_WITHDRAWAL") {
    return ledger().getAccount(app.prisma, { assetId, ownerId: userId, class: accountClass });
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const prisma = app.prisma;

    const tokenAddress = `0x${crypto.randomBytes(20).toString("hex")}`;
    const asset = await prisma.asset.create({
      data: {
        id: `eip155:${CHAIN_ID}/erc20:${tokenAddress}`,
        chainId: CHAIN_ID,
        tokenAddress,
        symbol: "USDC",
        decimals: 6,
        status: "ACTIVE",
        confirmations: 1,
        deepFinality: 2,
        treasuryAddress: TREASURY,
        rpcUrls: [],
        minGasAtomic: "0",
      },
    });
    assetId = asset.id;

    const user = await prisma.user.create({
      data: {
        username: `withdrawal_${Date.now()}`,
        address: walletAddress,
        role: "PLAYER",
        kind: "WALLET",
      },
    });
    userId = user.id;

    const jti = `wd_jti_${Date.now()}`;
    await prisma.session.create({
      data: { userId, jti, expiresAt: new Date(Date.now() + 3600_000) },
    });
    authToken = app.jwt.sign({ userId, jti }, { jti, expiresIn: "1h" });

    await fund("100000");
  }, 30000);

  afterAll(async () => {
    const prisma = app.prisma;
    await prisma.withdrawalIntentRecord.deleteMany({ where: { assetId } });
    await prisma.journalPosting.deleteMany({ where: { assetId } });
    await prisma.journalTransaction.deleteMany({ where: { assetId } });
    await prisma.atomicAccount.deleteMany({ where: { assetId } });
    await prisma.asset.deleteMany({ where: { id: assetId } });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  }, 30000);

  it("rejects a submission without a signature", async () => {
    const response = await submit(makeIntent());
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid signature", async () => {
    const response = await submit(makeIntent(), `0x${"0".repeat(130)}`);
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_FAILED");
  });

  it("rejects a signature from a different wallet", async () => {
    const other = privateKeyToAccount(`0x${crypto.randomBytes(32).toString("hex")}`);
    const intent = makeIntent();
    const response = await submit(intent, await signIntent(intent, other));
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_FAILED");
  });

  it("rejects an intent bound to a different principal", async () => {
    const intent = makeIntent({ principalId: "someone-else" });
    const response = await submit(intent, await signIntent(intent));
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN");
  });

  it("rejects a signature over a tampered amount", async () => {
    const intent = makeIntent({ amountAtomic: "100" });
    const signature = await signIntent(intent);
    const tampered = { ...intent, amountAtomic: "200" };
    const response = await submit(tampered, signature);
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_FAILED");
  });

  it("rejects a signature over a mismatched chain id", async () => {
    const intent = makeIntent();
    // Sign against a different chain's domain; the intent chainId is bound.
    const signature = await signIntent(
      intent,
      signer,
      createWithdrawalDomain(1, TREASURY) as never
    );
    const response = await submit(intent, signature);
    expect([400, 401]).toContain(response.statusCode);
  });

  it("rejects an expired intent", async () => {
    const intent = makeIntent({ deadline: Math.floor(Date.now() / 1000) - 10 });
    const response = await submit(intent, await signIntent(intent));
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("expired");
  });

  it("reserves funds atomically, is idempotent on replay and rejects a re-used nonce", async () => {
    const availableBefore = BigInt((await balanceClass("USER_AVAILABLE"))?.balanceAtomic ?? "0");
    const pendingBefore = BigInt((await balanceClass("PENDING_WITHDRAWAL"))?.balanceAtomic ?? "0");

    const intent = makeIntent({ amountAtomic: "100" });
    const signature = await signIntent(intent);

    const first = await submit(intent, signature);
    expect(first.statusCode, first.body).toBe(200);
    const record = WithdrawalRecordSchema.parse(first.json());
    expect(record.intentId).toBe(intent.intentId);
    expect(record.status).toBe("RESERVED");

    expect(BigInt((await balanceClass("USER_AVAILABLE"))!.balanceAtomic)).toBe(
      availableBefore - 100n
    );
    expect(BigInt((await balanceClass("PENDING_WITHDRAWAL"))!.balanceAtomic)).toBe(
      pendingBefore + 100n
    );

    // Same intent + signature replays the stored record without a second debit.
    const replay = await submit(intent, signature);
    expect(replay.statusCode).toBe(200);
    expect(WithdrawalRecordSchema.parse(replay.json()).intentId).toBe(intent.intentId);
    expect(BigInt((await balanceClass("USER_AVAILABLE"))!.balanceAtomic)).toBe(
      availableBefore - 100n
    );
    expect(BigInt((await balanceClass("PENDING_WITHDRAWAL"))!.balanceAtomic)).toBe(
      pendingBefore + 100n
    );
    expect(
      await app.prisma.journalTransaction.count({ where: { requestId: intent.intentId } })
    ).toBe(1);

    // Re-using the nonce with a different intent is a conflict, never a replay.
    const conflicting = {
      ...intent,
      intentId: `other-${crypto.randomUUID()}`,
      amountAtomic: "150",
    };
    const conflict = await submit(conflicting, await signIntent(conflicting));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("CONFLICT");
  });

  it("rejects a withdrawal above the available balance", async () => {
    const intent = makeIntent({ amountAtomic: "999999999" });
    const response = await submit(intent, await signIntent(intent));
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INSUFFICIENT_FUNDS");
  });

  it("lists the principal's durable withdrawal intents", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/finance/withdrawals",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.withdrawals)).toBe(true);
    for (const withdrawal of body.withdrawals) {
      WithdrawalRecordSchema.parse(withdrawal);
      // The full signed intent is projected (destination/amount/deadline/...).
      expect(withdrawal.destination).toBeTypeOf("string");
      expect(withdrawal.amountAtomic).toBeTypeOf("string");
      expect(withdrawal.deadline).toBeTypeOf("number");
      // Internal/signing material is never projected publicly.
      expect(withdrawal.signature).toBeUndefined();
      expect(withdrawal.reservedJournalId).toBeUndefined();
      expect(withdrawal.signedRawTx).toBeUndefined();
      expect(withdrawal.signedCallData).toBeUndefined();
      expect(withdrawal.idempotent).toBeUndefined();
    }
  });

  it("uses the fixed domain name/version binding", () => {
    const domain = createWithdrawalDomain(CHAIN_ID, TREASURY);
    expect(domain.name).toBe(WITHDRAWAL_DOMAIN_NAME);
    expect(domain.version).toBe(WITHDRAWAL_DOMAIN_VERSION);
    expect(domain.chainId).toBe(CHAIN_ID);
    expect(domain.verifyingContract).toBe(TREASURY);
  });
});
