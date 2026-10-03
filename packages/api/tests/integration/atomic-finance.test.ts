/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  WITHDRAWAL_INTENT_EIP712_FIELDS,
  WITHDRAWAL_DOMAIN_NAME,
  WITHDRAWAL_DOMAIN_VERSION,
  createWithdrawalDomain,
  WithdrawalRecordSchema,
} from "@pokertools/types";
import { buildApp } from "../../src/app.js";
import {
  AtomicLedger,
  LedgerInvariantError,
  LedgerConflictError,
} from "../../src/services/atomic-ledger.js";
import { FinancialIntentService } from "../../src/services/financial-intents.js";
import { FinancialIncidentService } from "../../src/services/financial-incidents.js";
import { createCustodyAccounting } from "../../src/services/custody-accounting.js";
import { ANVIL_PUBLIC_PRIVATE_KEY } from "../fixtures/anvil-public-key.js";

// This SQLite integration suite deliberately corrupts secondary ledgers. Its
// route-wide incidents must never freeze another suite's configured chain.
const CHAIN_ID = crypto.randomInt(1_000_000, 2_000_000);
const TEST_TIMEOUT = 30000;

function randomTokenAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

describe("Canonical atomic multi-asset finance", () => {
  let app: FastifyInstance;
  let prisma: FastifyInstance["prisma"];
  let assetId: string;
  let tokenAddress: string;
  let signer: ReturnType<typeof privateKeyToAccount>;
  let walletAddress: string;
  let userId: string;
  let ownerId: string;
  let token: string;
  const ownedAssets = new Set<string>();

  const ledgerFor = () => new AtomicLedger(app.prisma);

  async function createAsset(
    overrides: Partial<Parameters<typeof prisma.asset.create>[0]["data"]> = {}
  ) {
    const addr = (overrides.tokenAddress as string | undefined) ?? randomTokenAddress();
    const id = `eip155:${CHAIN_ID}/erc20:${addr}`;
    const asset = await prisma.asset.create({
      data: {
        id,
        chainId: CHAIN_ID,
        tokenAddress: addr,
        symbol: "USDC",
        decimals: 6,
        status: "ACTIVE",
        confirmations: 1,
        deepFinality: 2,
        treasuryAddress: "0x00000000000000000000000000000000000000aa",
        rpcUrls: [],
        minGasAtomic: "0",
        ...overrides,
      },
    });
    ownedAssets.add(asset.id);
    return asset;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    prisma = app.prisma;

    signer = privateKeyToAccount(ANVIL_PUBLIC_PRIVATE_KEY);
    walletAddress = signer.address.toLowerCase();

    tokenAddress = randomTokenAddress();
    const asset = await createAsset({ tokenAddress });
    assetId = asset.id;

    const user = await prisma.user.create({
      data: {
        username: `atomic_${Date.now()}`,
        address: walletAddress,
        role: "PLAYER",
        kind: "WALLET",
      },
    });
    userId = user.id;
    ownerId = user.id;

    const jti = `atomic_jti_${Date.now()}`;
    await prisma.session.create({
      data: { userId, jti, expiresAt: new Date(Date.now() + 3600_000) },
    });
    token = app.jwt.sign({ userId, jti }, { jti, expiresIn: "1h" });
  }, TEST_TIMEOUT);

  async function retireAsset(id: string) {
    await prisma.withdrawalIntentRecord.deleteMany({ where: { assetId: id } });
    await prisma.depositClaimRecord.deleteMany({ where: { assetId: id } });
    await prisma.financialIncident.deleteMany({ where: { assetId: id } });
    await prisma.treasuryReconciliation.deleteMany({ where: { assetId: id } });
    await prisma.journalPosting.deleteMany({ where: { assetId: id } });
    await prisma.journalTransaction.deleteMany({ where: { assetId: id } });
    await prisma.atomicAccount.deleteMany({ where: { assetId: id } });
    await prisma.asset.deleteMany({ where: { id } });
    ownedAssets.delete(id);
  }

  afterEach(async () => {
    for (const id of [...ownedAssets]) if (id !== assetId) await retireAsset(id);
  });

  afterAll(async () => {
    await prisma.financialIncident.deleteMany({ where: { chainId: CHAIN_ID } });
    for (const id of [...ownedAssets]) await retireAsset(id);
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  }, TEST_TIMEOUT);

  // -------------------------------------------------------------------------
  // AtomicLedger
  // -------------------------------------------------------------------------

  describe("AtomicLedger", () => {
    it("posts a balanced transaction and updates the projection", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const user = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const treasury = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });

      const journal = await ledger.postAtomic({
        requestId: `t1-${crypto.randomUUID()}`,
        assetId: asset.id,
        postings: [
          { accountId: treasury.accountId, amountAtomic: "-1000" },
          { accountId: user.accountId, amountAtomic: "1000" },
        ],
      });
      expect(journal.postings).toHaveLength(2);

      const userAfter = await ledger.getAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      expect(userAfter?.balanceAtomic).toBe("1000");
      expect(userAfter?.version).toBe(1);

      const tx = await prisma.journalTransaction.findUniqueOrThrow({ where: { id: journal.id } });
      expect(tx.sealed).toBe(true);
      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });

    it("rejects unbalanced and non-canonical postings", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const a = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const b = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });

      await expect(
        ledger.postAtomic({
          requestId: `bad-${crypto.randomUUID()}`,
          assetId: asset.id,
          postings: [
            { accountId: a.accountId, amountAtomic: "10" },
            { accountId: b.accountId, amountAtomic: "-9" },
          ],
        })
      ).rejects.toBeInstanceOf(LedgerInvariantError);

      await expect(
        ledger.postAtomic({
          requestId: `bad2-${crypto.randomUUID()}`,
          assetId: asset.id,
          postings: [
            { accountId: a.accountId, amountAtomic: "-0" },
            { accountId: b.accountId, amountAtomic: "0" },
          ],
        })
      ).rejects.toBeInstanceOf(LedgerInvariantError);

      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });

    it("never trusts a caller-supplied payloadHash", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const a = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const b = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      await expect(
        ledger.postAtomic({
          requestId: `hash-${crypto.randomUUID()}`,
          assetId: asset.id,
          payloadHash: "deadbeef",
          postings: [
            { accountId: a.accountId, amountAtomic: "5" },
            { accountId: b.accountId, amountAtomic: "-5" },
          ],
        })
      ).rejects.toBeInstanceOf(LedgerConflictError);
      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });

    it("blocks overspend on user accounts but allows explicit system debit", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const user = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const treasury = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });

      await expect(
        ledger.postAtomic({
          requestId: `over-${crypto.randomUUID()}`,
          assetId: asset.id,
          postings: [
            { accountId: user.accountId, amountAtomic: "-1" },
            { accountId: treasury.accountId, amountAtomic: "1" },
          ],
        })
      ).rejects.toThrow();

      // System debit may go negative.
      await ledger.postAtomic({
        requestId: `sys-${crypto.randomUUID()}`,
        assetId: asset.id,
        postings: [
          { accountId: treasury.accountId, amountAtomic: "-7" },
          { accountId: user.accountId, amountAtomic: "7" },
        ],
      });
      const treasuryAfter = await ledger.getAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      expect(treasuryAfter?.balanceAtomic).toBe("-7");
      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });

    it("is idempotent on requestId and rejects changed payloads", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const a = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const b = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      const requestId = `idem-${crypto.randomUUID()}`;
      const first = await ledger.postAtomic({
        requestId,
        assetId: asset.id,
        postings: [
          { accountId: a.accountId, amountAtomic: "11" },
          { accountId: b.accountId, amountAtomic: "-11" },
        ],
      });
      const replay = await ledger.postAtomic({
        requestId,
        assetId: asset.id,
        postings: [
          { accountId: a.accountId, amountAtomic: "11" },
          { accountId: b.accountId, amountAtomic: "-11" },
        ],
      });
      expect(replay.id).toBe(first.id);

      await expect(
        ledger.postAtomic({
          requestId,
          assetId: asset.id,
          postings: [
            { accountId: a.accountId, amountAtomic: "12" },
            { accountId: b.accountId, amountAtomic: "-12" },
          ],
        })
      ).rejects.toBeInstanceOf(LedgerConflictError);

      const count = await prisma.journalTransaction.count({
        where: { assetId: asset.id, requestId },
      });
      expect(count).toBe(1);
      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });

    it("survives concurrent same-request posts with one journal", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const a = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const b = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      const requestId = `race-${crypto.randomUUID()}`;
      const input = {
        requestId,
        assetId: asset.id,
        postings: [
          { accountId: a.accountId, amountAtomic: "3" },
          { accountId: b.accountId, amountAtomic: "-3" },
        ],
      };
      const settled = await Promise.allSettled([
        ledger.postAtomic(input),
        ledger.postAtomic(input),
      ]);
      const fulfilled = settled.filter(
        (entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof ledger.postAtomic>>> =>
          entry.status === "fulfilled"
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      if (fulfilled.length === 2) {
        expect(fulfilled[0].value.id).toBe(fulfilled[1].value.id);
      }
      expect(
        await prisma.journalTransaction.count({ where: { assetId: asset.id, requestId } })
      ).toBe(1);
      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });

    it("rebuild is deterministic and repairs tampered projections", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const user = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const treasury = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      await ledger.postAtomic({
        requestId: `rb-${crypto.randomUUID()}`,
        assetId: asset.id,
        postings: [
          { accountId: treasury.accountId, amountAtomic: "-50" },
          { accountId: user.accountId, amountAtomic: "50" },
        ],
      });

      // Tamper the cached projection without touching history.
      await prisma.atomicAccount.update({
        where: { id: user.accountId },
        data: { balanceAtomic: "999" },
      });

      const first = await ledger.rebuild();
      expect(first.changed).toBeGreaterThanOrEqual(1);
      const repaired = await ledger.getAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      expect(repaired?.balanceAtomic).toBe("50");

      const second = await ledger.rebuild();
      expect(second.changed).toBe(0);
      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });

    it("detects per-journal imbalance even when an asset nets to zero", async () => {
      const ledger = ledgerFor();
      const asset = await createAsset();
      const user = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId,
        class: "USER_AVAILABLE",
      });
      const treasury = await ledger.ensureAccount(prisma, {
        assetId: asset.id,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      // Two balanced journals net to zero.
      await ledger.postAtomic({
        requestId: `g1-${crypto.randomUUID()}`,
        assetId: asset.id,
        postings: [
          { accountId: treasury.accountId, amountAtomic: "-10" },
          { accountId: user.accountId, amountAtomic: "10" },
        ],
      });
      await ledger.postAtomic({
        requestId: `g2-${crypto.randomUUID()}`,
        assetId: asset.id,
        postings: [
          { accountId: user.accountId, amountAtomic: "-10" },
          { accountId: treasury.accountId, amountAtomic: "10" },
        ],
      });

      // Inject an imbalanced but sealed historical journal directly.
      const badTx = await prisma.journalTransaction.create({
        data: {
          assetId: asset.id,
          requestId: `bad-journal-${crypto.randomUUID()}`,
          payloadHash: "x".repeat(64),
          sealed: true,
        },
      });
      await prisma.journalPosting.create({
        data: {
          transactionId: badTx.id,
          assetId: asset.id,
          accountId: user.accountId,
          amountAtomic: "5",
        },
      });
      await prisma.journalPosting.create({
        data: {
          transactionId: badTx.id,
          assetId: asset.id,
          accountId: user.accountId,
          amountAtomic: "-3",
        },
      });

      await expect(ledger.assertAssetBalanced(prisma, asset.id)).rejects.toBeInstanceOf(
        LedgerInvariantError
      );
      await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
    });
  });

  // -------------------------------------------------------------------------
  // EIP-712 withdrawal intents
  // -------------------------------------------------------------------------

  describe("FinancialIntentService withdrawals", () => {
    function makeIntent(
      amountAtomic: string,
      nonce = Date.now(),
      deadline = Math.floor(Date.now() / 1000) + 600
    ) {
      const destination = `0x${crypto.randomBytes(20).toString("hex")}`;
      return {
        intentId: `intent-${crypto.randomUUID()}`,
        principalId: userId,
        assetId,
        destination,
        amountAtomic,
        nonce,
        deadline,
        chainId: CHAIN_ID,
      };
    }

    async function sign(intent: ReturnType<typeof makeIntent>) {
      const domain = createWithdrawalDomain(CHAIN_ID, "0x00000000000000000000000000000000000000aa");
      return signer.signTypedData({
        domain: domain as never,
        types: { WithdrawalIntent: [...WITHDRAWAL_INTENT_EIP712_FIELDS] } as never,
        primaryType: "WithdrawalIntent",
        message: { ...intent } as never,
      });
    }

    async function fundUser(amount: string) {
      const ledger = ledgerFor();
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      const user = await ledger.ensureAccount(prisma, {
        assetId,
        ownerId: userId,
        class: "USER_AVAILABLE",
      });
      const treasury = await ledger.ensureAccount(prisma, {
        assetId,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      await ledger.postAtomic({
        requestId: `fund-${crypto.randomUUID()}`,
        assetId: asset.id,
        postings: [
          { accountId: treasury.accountId, amountAtomic: `-${amount}` },
          { accountId: user.accountId, amountAtomic: amount },
        ],
      });
    }

    it("reserves funds atomically and is idempotent on replay", async () => {
      await fundUser("1000");
      const intent = makeIntent("100");
      const signature = await sign(intent);
      const service = new FinancialIntentService(app.prisma, ledgerFor());

      const result = await service.reserveWithdrawal({
        principal: { id: userId, kind: "WALLET", walletAddress },
        intent,
        signature,
      });
      expect(result.idempotent).toBe(false);
      expect(result.record.state).toBe("RESERVED");
      expect(result.record.treasuryAddress).toBe("0x00000000000000000000000000000000000000aa");
      expect(result.record.tokenAddress).toBe(tokenAddress);

      const ledger = ledgerFor();
      const available = await ledger.getAccount(prisma, {
        assetId,
        ownerId: userId,
        class: "USER_AVAILABLE",
      });
      const pending = await ledger.getAccount(prisma, {
        assetId,
        ownerId: userId,
        class: "PENDING_WITHDRAWAL",
      });
      expect(available?.balanceAtomic).toBe("900");
      expect(pending?.balanceAtomic).toBe("100");

      const replay = await service.reserveWithdrawal({
        principal: { id: userId, kind: "WALLET", walletAddress },
        intent,
        signature,
      });
      expect(replay.idempotent).toBe(true);
      expect(replay.record.id).toBe(result.record.id);
      expect(await prisma.journalTransaction.count({ where: { requestId: intent.intentId } })).toBe(
        1
      );
    });

    it("rejects a signature from a different wallet", async () => {
      const intent = makeIntent("50", Date.now() + 1);
      const other = privateKeyToAccount(`0x${crypto.randomBytes(32).toString("hex")}`);
      const domain = createWithdrawalDomain(CHAIN_ID, "0x00000000000000000000000000000000000000aa");
      const signature = await other.signTypedData({
        domain: domain as never,
        types: { WithdrawalIntent: [...WITHDRAWAL_INTENT_EIP712_FIELDS] } as never,
        primaryType: "WithdrawalIntent",
        message: { ...intent } as never,
      });
      const service = new FinancialIntentService(app.prisma, ledgerFor());
      await expect(
        service.reserveWithdrawal({
          principal: { id: userId, kind: "WALLET", walletAddress },
          intent,
          signature,
        })
      ).rejects.toThrow();
    });

    it("forbids SERVICE principals", async () => {
      const intent = makeIntent("50", Date.now() + 2);
      const signature = await sign(intent);
      const service = new FinancialIntentService(app.prisma, ledgerFor());
      await expect(
        service.reserveWithdrawal({
          principal: { id: userId, kind: "SERVICE", walletAddress: null },
          intent,
          signature,
        })
      ).rejects.toThrow();
    });

    it("rejects an intent whose principalId is not the authenticated actor", async () => {
      const intent = makeIntent("50", Date.now() + 20);
      const signature = await sign(intent);
      const service = new FinancialIntentService(app.prisma, ledgerFor());
      await expect(
        service.reserveWithdrawal({
          principal: { id: userId, kind: "WALLET", walletAddress },
          // Signed by the actor, but bound to a different principal.
          intent: { ...intent, principalId: "someone-else" },
          signature,
        })
      ).rejects.toThrow(/principal/i);
    });

    it("blocks reservation while a critical incident is open for the asset or chain", async () => {
      await fundUser("1000");
      const incidents = new FinancialIncidentService(app.prisma, ledgerFor());
      const incident = await incidents.open({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        assetId,
        chainId: CHAIN_ID,
        evidence: { note: "route is frozen" },
      });
      const intent = makeIntent("10", Date.now() + 21);
      const signature = await sign(intent);
      const service = new FinancialIntentService(app.prisma, ledgerFor());
      await expect(
        service.reserveWithdrawal({
          principal: { id: userId, kind: "WALLET", walletAddress },
          intent,
          signature,
        })
      ).rejects.toThrow(/critical incident/i);
      await prisma.financialIncident.update({
        where: { id: incident.id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          operatorId: userId,
          operatorEvidence: { note: "cleared" },
        },
      });
    });

    it("rejects an expired intent and a frozen asset", async () => {
      const intent = makeIntent("10", Date.now() + 3, Math.floor(Date.now() / 1000) - 1);
      const signature = await sign(intent);
      const service = new FinancialIntentService(app.prisma, ledgerFor());
      await expect(
        service.reserveWithdrawal({
          principal: { id: userId, kind: "WALLET", walletAddress },
          intent,
          signature,
        })
      ).rejects.toThrow();

      await prisma.asset.update({ where: { id: assetId }, data: { status: "FROZEN" } });
      const fresh = makeIntent("10", Date.now() + 4);
      const freshSig = await sign(fresh);
      await expect(
        service.reserveWithdrawal({
          principal: { id: userId, kind: "WALLET", walletAddress },
          intent: fresh,
          signature: freshSig,
        })
      ).rejects.toThrow();
      await prisma.asset.update({ where: { id: assetId }, data: { status: "ACTIVE" } });
    });
  });

  // -------------------------------------------------------------------------
  // HTTP route surface
  // -------------------------------------------------------------------------

  describe("finance HTTP routes", () => {
    it("rejects client-supplied typedData and never leaks signatures", async () => {
      await fundUserHttp();
      const intent = {
        intentId: `http-${crypto.randomUUID()}`,
        principalId: userId,
        assetId,
        destination: `0x${crypto.randomBytes(20).toString("hex")}`,
        amountAtomic: "25",
        nonce: Date.now() + 100,
        deadline: Math.floor(Date.now() / 1000) + 600,
        chainId: CHAIN_ID,
      };
      const domain = createWithdrawalDomain(CHAIN_ID, "0x00000000000000000000000000000000000000aa");
      const signature = await signer.signTypedData({
        domain: domain as never,
        types: { WithdrawalIntent: [...WITHDRAWAL_INTENT_EIP712_FIELDS] } as never,
        primaryType: "WithdrawalIntent",
        message: { ...intent } as never,
      });

      const withTypedData = await app.inject({
        method: "POST",
        url: "/finance/withdrawals/intents",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          intent,
          signature,
          typedData: { types: {}, primaryType: "x", domain, message: {} },
        },
      });
      expect(withTypedData.statusCode).toBe(400);

      const ok = await app.inject({
        method: "POST",
        url: "/finance/withdrawals/intents",
        headers: { authorization: `Bearer ${token}` },
        payload: { intent, signature },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const body = ok.json();
      // Strict shared WithdrawalRecord contract: signed intent + lifecycle.
      const record = WithdrawalRecordSchema.parse(body);
      expect(record.intentId).toBe(intent.intentId);
      expect(record.principalId).toBe(userId);
      expect(record.status).toBe("RESERVED");
      expect(record.amountAtomic).toBe("25");
      // Internal reservation metadata and signed raw material are never returned.
      for (const forbidden of [
        "signature",
        "signedRawTx",
        "signedCallData",
        "reservedJournalId",
        "idempotent",
      ]) {
        expect(body[forbidden]).toBeUndefined();
      }

      const detail = await app.inject({
        method: "GET",
        url: `/finance/withdrawals/${intent.intentId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.statusCode).toBe(200);
      expect(WithdrawalRecordSchema.parse(detail.json()).intentId).toBe(intent.intentId);
      expect(detail.json().signature).toBeUndefined();
    });

    it("serves canonical asset metadata without leaking treasury/RPC", async () => {
      const res = await app.inject({ method: "GET", url: "/finance/assets" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const asset = body.assets.find((entry: { assetId: string }) => entry.assetId === assetId);
      expect(asset).toBeDefined();
      expect(asset.treasuryAddress).toBeUndefined();
      expect(asset.rpcUrls).toBeUndefined();
    });

    async function fundUserHttp() {
      const ledger = ledgerFor();
      const user = await ledger.ensureAccount(prisma, {
        assetId,
        ownerId: userId,
        class: "USER_AVAILABLE",
      });
      const treasury = await ledger.ensureAccount(prisma, {
        assetId,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      await ledger.postAtomic({
        requestId: `fund-http-${crypto.randomUUID()}`,
        assetId,
        postings: [
          { accountId: treasury.accountId, amountAtomic: "-500" },
          { accountId: user.accountId, amountAtomic: "500" },
        ],
      });
    }
  });

  // -------------------------------------------------------------------------
  // Incidents, reorgs and reconciliation
  // -------------------------------------------------------------------------

  describe("FinancialIncidentService", () => {
    it("resolves with readiness re-check and unfreezes the asset in the same transaction", async () => {
      const ledger = ledgerFor();
      const incidents = new FinancialIncidentService(app.prisma, ledger);
      const incident = await incidents.open({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        assetId,
        chainId: CHAIN_ID,
        evidence: { note: "quorum disagreement" },
      });
      await prisma.asset.update({ where: { id: assetId }, data: { status: "FROZEN" } });
      // Resolution now requires a fresh, matched, fully-provenanced
      // reconciliation inside the same locked transaction.
      await incidents.recordReconciliation({
        assetId,
        chainId: CHAIN_ID,
        observedAtomic: "0",
        ledgerAtomic: "0",
        blockNumber: "1",
        evidence: { block: 1 },
      });

      let checked = false;
      const resolved = await incidents.resolve({
        incidentId: incident.id,
        operatorId: userId,
        operatorEvidence: { checked: true },
        readinessCheck: async () => {
          checked = true;
        },
      });
      expect(checked).toBe(true);
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.version).toBe(incident.version + 1);
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.status).toBe("ACTIVE");
    });

    it("opens a critical incident and freezes the whole chain atomically, then resolves it", async () => {
      const ledger = ledgerFor();
      const incidents = new FinancialIncidentService(app.prisma, ledger);
      const other = await createAsset();

      const result = await incidents.openCriticalIncidentAndFreeze({
        kind: "CUSTODY_FAILURE",
        severity: "CRITICAL",
        chainId: CHAIN_ID,
        evidence: { reason: "route-wide freeze" },
        freezeChainWide: true,
      });
      expect(result.frozenAssetIds).toContain(assetId);
      expect(result.frozenAssetIds).toContain(other.id);
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
        "FROZEN"
      );

      // Resolution requires fresh reconciliation for every asset on the chain.
      const chainAssets = await prisma.asset.findMany({
        where: { chainId: CHAIN_ID },
        select: { id: true },
      });
      for (const chainAsset of chainAssets) {
        await incidents.recordReconciliation({
          assetId: chainAsset.id,
          chainId: CHAIN_ID,
          observedAtomic: "0",
          ledgerAtomic: "0",
          blockNumber: "3",
          evidence: { block: 3 },
        });
      }

      const resolved = await incidents.resolve({
        incidentId: result.incident.id,
        operatorId: userId,
        operatorEvidence: { checked: true },
        readinessCheck: async () => undefined,
      });
      expect(resolved.status).toBe("RESOLVED");
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: assetId } })).status).toBe(
        "ACTIVE"
      );
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
        "ACTIVE"
      );

      await prisma.treasuryReconciliation.deleteMany({ where: { assetId: other.id } });
      await prisma.asset.delete({ where: { id: other.id } }).catch(() => undefined);
    });

    it("refuses resolution without a readiness check (no default success)", async () => {
      const incidents = new FinancialIncidentService(app.prisma, ledgerFor());
      const incident = await incidents.open({
        kind: "GAS_STARVATION",
        evidence: { note: "no native gas" },
      });
      await expect(
        incidents.resolve({
          incidentId: incident.id,
          operatorId: userId,
          operatorEvidence: { checked: true },
        } as never)
      ).rejects.toThrow(/readiness/i);
      const stillOpen = await prisma.financialIncident.findUniqueOrThrow({
        where: { id: incident.id },
      });
      expect(stillOpen.status).toBe("OPEN");
      // Cleanup: resolve explicitly with a real (injected) check.
      await incidents.resolve({
        incidentId: incident.id,
        operatorId: userId,
        operatorEvidence: { checked: true },
        readinessCheck: async () => undefined,
      });
    });

    it("refuses resolution while another blocking incident remains open", async () => {
      const incidents = new FinancialIncidentService(app.prisma, ledgerFor());
      const first = await incidents.open({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        assetId,
        chainId: CHAIN_ID,
        evidence: { note: "first" },
      });
      const second = await incidents.open({
        kind: "WITHDRAWAL_REORG",
        severity: "CRITICAL",
        assetId,
        chainId: CHAIN_ID,
        evidence: { note: "second" },
      });
      await incidents.recordReconciliation({
        assetId,
        chainId: CHAIN_ID,
        observedAtomic: "0",
        ledgerAtomic: "0",
        blockNumber: "2",
        evidence: { block: 2 },
      });
      await expect(
        incidents.resolve({
          incidentId: first.id,
          operatorId: userId,
          operatorEvidence: { checked: true },
          readinessCheck: async () => undefined,
        })
      ).rejects.toThrow(/blocking/i);
      expect(
        (await prisma.financialIncident.findUniqueOrThrow({ where: { id: first.id } })).status
      ).toBe("OPEN");
      await prisma.financialIncident.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    });

    it("leaves the incident open when readiness fails", async () => {
      const incidents = new FinancialIncidentService(app.prisma, ledgerFor());
      const incident = await incidents.open({
        kind: "GAS_STARVATION",
        evidence: { note: "no native gas" },
      });
      await expect(
        incidents.resolve({
          incidentId: incident.id,
          operatorId: userId,
          operatorEvidence: { checked: false },
          readinessCheck: async () => {
            throw new Error("still starved");
          },
        })
      ).rejects.toThrow();
      const stillOpen = await prisma.financialIncident.findUniqueOrThrow({
        where: { id: incident.id },
      });
      expect(stillOpen.status).toBe("OPEN");
    });

    it("preserves user liability on deposit reorg (no duplicate obligation)", async () => {
      const ledger = ledgerFor();
      const intents = new FinancialIntentService(app.prisma, ledger);
      const claim = await intents.creditDepositClaim({
        principalId: userId,
        assetId,
        chainId: CHAIN_ID,
        txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
        logIndex: 7,
        amountAtomic: "40",
      });
      const before = await ledger.getAccount(prisma, {
        assetId,
        ownerId: userId,
        class: "USER_AVAILABLE",
      });
      const journalsBefore = await prisma.journalTransaction.count({ where: { assetId } });
      const reorg = await intents.recordDepositReorg({
        claimId: claim.id,
        evidence: { reason: "canonical reorg" },
      });
      expect(reorg.incident.kind).toBe("DEPOSIT_REORG");
      expect(reorg.claim.status).toBe("ORPHANED");
      const after = await ledger.getAccount(prisma, {
        assetId,
        ownerId: userId,
        class: "USER_AVAILABLE",
      });
      expect(after?.balanceAtomic).toBe(before?.balanceAtomic);
      // No second journal was posted for the reorg.
      expect(await prisma.journalTransaction.count({ where: { assetId } })).toBe(journalsBefore);
    });

    it("restores the obligation exactly once on post-completion withdrawal reorg through the custody accounting adapter", async () => {
      const ledger = ledgerFor();
      const intents = new FinancialIntentService(app.prisma, ledger);
      const incidents = new FinancialIncidentService(app.prisma, ledger);
      const accounting = createCustodyAccounting({ prisma: app.prisma, ledger, incidents });
      const user = await ledger.ensureAccount(prisma, {
        assetId,
        ownerId: userId,
        class: "USER_AVAILABLE",
      });
      const treasury = await ledger.ensureAccount(prisma, {
        assetId,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });
      await ledger.postAtomic({
        requestId: `reorg-fund-${crypto.randomUUID()}`,
        assetId,
        postings: [
          { accountId: treasury.accountId, amountAtomic: "-200" },
          { accountId: user.accountId, amountAtomic: "200" },
        ],
      });

      const intent = {
        intentId: `reorg-intent-${crypto.randomUUID()}`,
        principalId: userId,
        assetId,
        destination: `0x${crypto.randomBytes(20).toString("hex")}`,
        amountAtomic: "30",
        nonce: Date.now() + 500,
        deadline: Math.floor(Date.now() / 1000) + 600,
        chainId: CHAIN_ID,
      };
      const domain = createWithdrawalDomain(CHAIN_ID, "0x00000000000000000000000000000000000000aa");
      const signature = await signer.signTypedData({
        domain: domain as never,
        types: { WithdrawalIntent: [...WITHDRAWAL_INTENT_EIP712_FIELDS] } as never,
        primaryType: "WithdrawalIntent",
        message: { ...intent } as never,
      });
      // Reservation blocks while a critical incident is open. The preceding
      // deposit-reorg case leaves one open for this asset; clear it (as an
      // operator resolution would) before exercising the withdrawal reorg path.
      await prisma.financialIncident.updateMany({
        where: { assetId, status: { not: "RESOLVED" } },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          operatorId: userId,
          operatorEvidence: { note: "test-cleared" },
        },
      });
      await intents.reserveWithdrawal({
        principal: { id: userId, kind: "WALLET", walletAddress },
        intent,
        signature,
      });

      const record = {
        intentId: intent.intentId,
        principalId: userId,
        assetId,
        chainId: CHAIN_ID,
        amountAtomic: "30",
      };
      // Canonical production settlement path (custody workflow accounting port).
      await accounting.completeWithdrawal(record);
      const settled = await prisma.withdrawalIntentRecord.findUniqueOrThrow({
        where: { id: intent.intentId },
      });
      expect(settled.confirmedJournalId).not.toBeNull();
      const userAvailableAfterSettlement = (
        await ledger.getAccount(prisma, {
          assetId,
          ownerId: userId,
          class: "USER_AVAILABLE",
        })
      )?.balanceAtomic;

      const incident = await incidents.open({
        kind: "WITHDRAWAL_REORG",
        severity: "CRITICAL",
        assetId,
        chainId: CHAIN_ID,
        affectedId: intent.intentId,
        evidence: { reason: "canonical reorg" },
      });
      // Custody owns the withdrawal lifecycle state: simulate the durable
      // post-reorg row its CAS would commit before the API accounting adapter
      // is invoked, including the exact payout identity the adapter binds to.
      const reorgTxHash = `0x${crypto.randomBytes(32).toString("hex")}`;
      const priorReceiptBlockNumber = "4242";
      const priorReceiptBlockHash = `0x${crypto.randomBytes(32).toString("hex")}`;
      const obligationEvidence = {
        txHash: reorgTxHash,
        priorReceiptBlockNumber,
        priorReceiptBlockHash,
      };
      await prisma.withdrawalIntentRecord.update({
        where: { id: intent.intentId },
        data: {
          state: "REORGED",
          txHash: reorgTxHash,
          receiptBlockNumber: priorReceiptBlockNumber,
          receiptBlockHash: priorReceiptBlockHash,
        },
      });

      const obligation = await accounting.recordObligation(
        record,
        { incidentId: incident.id },
        obligationEvidence
      );
      expect(incident.kind).toBe("WITHDRAWAL_REORG");
      expect(obligation.journalId).toBeTruthy();
      expect(
        (
          await ledger.getAccount(prisma, {
            assetId,
            ownerId: null,
            class: "INCIDENT_OBLIGATION",
          })
        )?.balanceAtomic
      ).toBe("30");

      // Replay is idempotent: exactly one obligation journal, no second
      // liability, and the user is never debited by the reorg path.
      const replay = await accounting.recordObligation(
        record,
        { incidentId: incident.id },
        obligationEvidence
      );
      expect(replay.journalId).toBe(obligation.journalId);
      expect(
        (
          await ledger.getAccount(prisma, {
            assetId,
            ownerId: null,
            class: "INCIDENT_OBLIGATION",
          })
        )?.balanceAtomic
      ).toBe("30");
      expect(
        await prisma.journalTransaction.count({
          where: { assetId, requestId: `withdrawal-reorg:${intent.intentId}` },
        })
      ).toBe(1);
      // The reorg obligation path never debits the user.
      expect(
        (
          await ledger.getAccount(prisma, {
            assetId,
            ownerId: userId,
            class: "USER_AVAILABLE",
          })
        )?.balanceAtomic
      ).toBe(userAvailableAfterSettlement);
    });

    it("persists reconciliation evidence with signed difference", async () => {
      const incidents = new FinancialIncidentService(app.prisma, ledgerFor());
      const matched = await incidents.recordReconciliation({
        assetId,
        chainId: CHAIN_ID,
        observedAtomic: "100",
        ledgerAtomic: "100",
        evidence: { block: 1 },
      });
      expect(matched.status).toBe("MATCHED");
      expect(matched.differenceAtomic).toBe("0");

      const mismatched = await incidents.recordReconciliation({
        assetId,
        chainId: CHAIN_ID,
        observedAtomic: "90",
        ledgerAtomic: "100",
        evidence: { block: 2 },
      });
      expect(mismatched.status).toBe("MISMATCH");
      expect(mismatched.differenceAtomic).toBe("-10");
    });
  });
});
