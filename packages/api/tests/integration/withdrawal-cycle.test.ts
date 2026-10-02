/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  WITHDRAWAL_INTENT_EIP712_FIELDS,
  WITHDRAWAL_INTENT_PRIMARY_TYPE,
  createWithdrawalDomain,
  WithdrawalRecordSchema,
} from "@pokertools/types";
import { buildApp } from "../../src/app.js";
import { AtomicLedger } from "../../src/services/atomic-ledger.js";
import type { FastifyInstance } from "fastify";

const CHAIN_ID = 31337;
const TREASURY = "0x00000000000000000000000000000000000000aa";
const DESTINATION = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

/**
 * Canonical withdrawal lifecycle at the durable authority boundary.
 *
 * The legacy cents lifecycle (PaymentTransaction + automatic broadcast refunds)
 * is gone. A withdrawal is an EIP-712 intent durably reserved in the atomic
 * ledger; custody consumes the persisted record. This suite pins the durable
 * reservation invariants: exact once accounting, nonce identity, deadline
 * binding and exact atomic amounts.
 */
describe("Canonical withdrawal lifecycle", () => {
  let app: FastifyInstance;
  let assetId: string;
  let userId: string;
  let token: string;

  const signer = privateKeyToAccount(generatePrivateKey());
  const walletAddress = signer.address.toLowerCase();
  const ledger = () => new AtomicLedger(app.prisma);

  function makeIntent(amountAtomic: string, deadlineOffsetSeconds = 600) {
    return {
      intentId: `intent-${crypto.randomUUID()}`,
      principalId: userId,
      assetId,
      destination: DESTINATION,
      amountAtomic,
      nonce: Date.now() + Math.floor(Math.random() * 100_000),
      deadline: Math.floor(Date.now() / 1000) + deadlineOffsetSeconds,
      chainId: CHAIN_ID,
    };
  }

  async function sign(intent: ReturnType<typeof makeIntent>) {
    return signer.signTypedData({
      domain: createWithdrawalDomain(CHAIN_ID, TREASURY),
      types: { [WITHDRAWAL_INTENT_PRIMARY_TYPE]: [...WITHDRAWAL_INTENT_EIP712_FIELDS] },
      primaryType: WITHDRAWAL_INTENT_PRIMARY_TYPE,
      message: intent,
    } as never);
  }

  async function submit(intent: ReturnType<typeof makeIntent>, signature: `0x${string}`) {
    return app.inject({
      method: "POST",
      url: "/finance/withdrawals/intents",
      headers: { authorization: `Bearer ${token}` },
      payload: { intent, signature },
    });
  }

  async function reserve(intent: ReturnType<typeof makeIntent>) {
    return submit(intent, await sign(intent));
  }

  async function balance(accountClass: "USER_AVAILABLE" | "PENDING_WITHDRAWAL") {
    return ledger().getAccount(app.prisma, { assetId, ownerId: userId, class: accountClass });
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

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenAddress = `0x${crypto.randomBytes(20).toString("hex")}`;
    const asset = await app.prisma.asset.create({
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

    const user = await app.prisma.user.create({
      data: {
        username: `wdcycle_${Date.now()}`,
        address: walletAddress,
        role: "PLAYER",
        kind: "WALLET",
      },
    });
    userId = user.id;
    const jti = `wdcycle_jti_${Date.now()}`;
    await app.prisma.session.create({
      data: { userId, jti, expiresAt: new Date(Date.now() + 3600_000) },
    });
    token = app.jwt.sign({ userId, jti }, { jti, expiresIn: "1h" });
    await fund("100000");
  }, 30000);

  afterAll(async () => {
    await app.prisma.withdrawalIntentRecord.deleteMany({ where: { assetId } });
    await app.prisma.journalPosting.deleteMany({ where: { assetId } });
    await app.prisma.journalTransaction.deleteMany({ where: { assetId } });
    await app.prisma.atomicAccount.deleteMany({ where: { assetId } });
    await app.prisma.asset.deleteMany({ where: { id: assetId } });
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  }, 30000);

  it("durably reserves the full intent and journals a balanced hold exactly once", async () => {
    const availableBefore = BigInt((await balance("USER_AVAILABLE"))?.balanceAtomic ?? "0");
    const pendingBefore = BigInt((await balance("PENDING_WITHDRAWAL"))?.balanceAtomic ?? "0");
    const intent = makeIntent("100");
    const signature = await sign(intent);

    const response = await submit(intent, signature);
    expect(response.statusCode, response.body).toBe(200);
    const record = WithdrawalRecordSchema.parse(response.json());
    expect(record.intentId).toBe(intent.intentId);
    expect(record.destination).toBe(DESTINATION);
    expect(record.amountAtomic).toBe("100");
    expect(record.status).toBe("RESERVED");

    // Durable record is available for custody consumption with immutable
    // route provenance and the signed intent identity.
    const persisted = await app.prisma.withdrawalIntentRecord.findUniqueOrThrow({
      where: { id: intent.intentId },
    });
    expect(persisted.state).toBe("RESERVED");
    expect(persisted.assetId).toBe(assetId);
    expect(persisted.principalId).toBe(userId);
    expect(persisted.treasuryAddress).toBe(TREASURY);
    expect(persisted.tokenAddress).toBe(
      (await app.prisma.asset.findUniqueOrThrow({ where: { id: assetId } })).tokenAddress
    );

    expect(BigInt((await balance("USER_AVAILABLE"))?.balanceAtomic ?? "0")).toBe(
      availableBefore - 100n
    );
    expect(BigInt((await balance("PENDING_WITHDRAWAL"))?.balanceAtomic ?? "0")).toBe(
      pendingBefore + 100n
    );

    // Exactly one journal transaction for this intent (balanced reservation).
    expect(
      await app.prisma.journalTransaction.count({ where: { requestId: intent.intentId } })
    ).toBe(1);
  });

  it("replays idempotently without a second hold", async () => {
    const pendingBefore = BigInt((await balance("PENDING_WITHDRAWAL"))?.balanceAtomic ?? "0");
    const intent = makeIntent("50");
    const signature = await sign(intent);

    const first = await submit(intent, signature);
    expect(first.statusCode, first.body).toBe(200);

    const replay = await submit(intent, signature);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().intentId).toBe(intent.intentId);

    // No second hold and no second journal.
    expect(BigInt((await balance("PENDING_WITHDRAWAL"))?.balanceAtomic ?? "0")).toBe(
      pendingBefore + 50n
    );
    expect(
      await app.prisma.journalTransaction.count({ where: { requestId: intent.intentId } })
    ).toBe(1);
  });

  it("binds the deadline: a far-future deadline is accepted and an expired one rejected", async () => {
    const accepted = await reserve(makeIntent("10", 3600));
    expect(accepted.statusCode, accepted.body).toBe(200);

    const expired = await reserve(makeIntent("10", -10));
    expect(expired.statusCode).toBe(400);
    expect(expired.json().message).toContain("expired");
  });

  it("preserves exact atomic amounts without float conversion", async () => {
    const pendingBefore = BigInt((await balance("PENDING_WITHDRAWAL"))?.balanceAtomic ?? "0");
    const intent = makeIntent("29");
    const response = await reserve(intent);
    expect(response.statusCode, response.body).toBe(200);

    expect(BigInt((await balance("PENDING_WITHDRAWAL"))?.balanceAtomic ?? "0")).toBe(
      pendingBefore + 29n
    );
    const persisted = await app.prisma.withdrawalIntentRecord.findUniqueOrThrow({
      where: { id: intent.intentId },
    });
    expect(persisted.amountAtomic).toBe("29");
  });
});
