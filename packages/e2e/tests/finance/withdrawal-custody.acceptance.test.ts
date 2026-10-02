/**
 * Withdrawal custody acceptance against the REAL public API + REAL PostgreSQL
 * custody ports + REAL Anvil.
 *
 * Flow under test:
 *   1. real SIWE wallet session (public `/auth/*`);
 *   2. real on-chain deposit claim credited through `/finance/deposits/claim`;
 *   3. EIP-712 intent signed by the wallet and reserved through
 *      `/finance/withdrawals/intents` (durable `PENDING_WITHDRAWAL` journal);
 *   4. custody `WithdrawalWorkflow` over `PrismaWithdrawalStore` signs, persists
 *      EXACT bytes before any broadcast, broadcasts, reaches quorum finality and
 *      completes the journal through the real `AtomicLedger`;
 *   5. a genuine process restart is a NEW workflow/store reading only PostgreSQL;
 *   6. accepted-but-dropped broadcast, gas starvation + replenish, and a
 *      missing-receipt withdrawal reorg that preserves the obligation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { keccak256, parseEther, parseUnits } from "viem";
import { bigIntToAtomicAmount, type WithdrawalIntent } from "@pokertools/types";
import {
  buildWithdrawalDomain,
  recoverWithdrawalSigner,
  signWithdrawalIntent,
} from "./helpers/eip712.js";
import { acceptedButDroppedBroadcaster, buildCustodyHarness } from "./helpers/custody-harness.js";
import { ViemTreasuryBroadcaster } from "../../../custody/src/core/viem-ports.js";
import { CustodyWorker } from "../../../custody/src/workers/custody-worker.js";
import {
  attachTwoChainAnvil,
  CHAIN_A_ID,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  getNativeBalance,
  mine,
  mintToken,
  readTokenBalance,
  revertSnapshot,
  setNativeBalance,
  snapshot,
  transferToken,
  type DeployedToken,
  type LocalChain,
} from "./helpers/anvil-two-chain.js";
import { startQuorumProxies, type ProxySet } from "./helpers/quorum-proxy.js";
import { createAssetFixture, resolveAllOpenIncidents } from "./helpers/finance-fixtures.js";
import { requireInfra } from "./helpers/infra.js";
// @ts-ignore - cross-package source import resolved by vitest
import { createPrismaClient } from "../../../api/src/utils/prisma-client.js";
import {
  bootFinanceApi,
  claimDeposit,
  closeFinanceApi,
  configureFinanceApiEnv,
  getBalances,
  siweLogin,
  submitWithdrawalIntent,
  type WalletAuth,
} from "./helpers/finance-api-harness.js";

const TREASURY_INDEX = 0;
const ALICE_INDEX = 11;
const TREASURY = getAccount(TREASURY_INDEX).address.toLowerCase() as Address;
const ALICE_ADDRESS = getAccount(ALICE_INDEX).address.toLowerCase();
const TREASURY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

describe("withdrawal custody acceptance (real API + Prisma stores + real Anvil)", () => {
  let chain: LocalChain;
  let token: DeployedToken;
  let proxies: ProxySet;
  let prisma: ReturnType<typeof createPrismaClient>;
  let databaseUrl: string;
  let alice: WalletAuth;
  let assetId: string;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 4_300));

  beforeAll(async () => {
    const infra = requireInfra();
    databaseUrl = infra.databaseUrl;
    configureFinanceApiEnv({ databaseUrl: infra.databaseUrl, redisUrl: infra.redisUrl });
    prisma = createPrismaClient();
    await resolveAllOpenIncidents(prisma);
    ({ chainA: chain } = await attachTwoChainAnvil());
    token = await deployMockUsdc6(chain);
    assetId = `eip155:${CHAIN_A_ID}/erc20:${token.address.toLowerCase()}`;

    proxies = await startQuorumProxies(chain.rpcUrl, 2);
    const app = await bootFinanceApi(infra);
    alice = await siweLogin(app, getAccount(ALICE_INDEX));

    await createAssetFixture(prisma, {
      assetId,
      chainId: CHAIN_A_ID,
      tokenAddress: token.address,
      symbol: token.symbol,
      decimals: 6,
      treasuryAddress: TREASURY,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      confirmations: 1,
      deepFinality: 3,
      minGasAtomic: parseEther("0.1").toString(),
    });

    // Real funding: treasury is prefunded to pay withdrawals; Alice's ledger
    // credit comes from a real on-chain deposit claim through the public API.
    await mintToken(chain, token.address, TREASURY as Address, parseUnits("1000", 6));
    const amount = parseUnits("50", 6);
    await mintToken(chain, token.address, ALICE_ADDRESS as Address, amount);
    const receipt = await transferToken(chain, token.address, ALICE_INDEX, TREASURY, amount);
    const [log] = findTransferLogs(receipt, token.address, { from: ALICE_ADDRESS, to: TREASURY });
    await mine(chain, 1);
    await settle();

    const claim = await claimDeposit(app, alice, {
      assetId,
      txHash: log.txHash,
      logIndex: log.logIndex,
    });
    expect(claim.status).toBeLessThan(300);

    const balances = await getBalances(app, alice);
    expect(balances.status).toBe(200);
    expect(
      (
        balances.body as { balances: Array<{ assetId: string; availableAtomic: string }> }
      ).balances.find((b) => b.assetId === assetId)?.availableAtomic
    ).toBe(amount.toString());
  });

  afterAll(async () => {
    // Retire this file's asset so later files' app-level chain registry does
    // not try to reach these (now closed) proxy endpoints.
    await prisma.asset
      .update({ where: { id: assetId }, data: { status: "FROZEN" } })
      .catch(() => undefined);
    await resolveAllOpenIncidents(prisma);
    await closeFinanceApi();
    await proxies?.close();
    await prisma?.$disconnect();
  });

  /**
   * Test isolation only: close any incident a scenario opened and clear the
   * route freeze so the next scenario can reserve through the public API. This
   * never touches journal history or balances.
   */
  afterEach(async () => {
    await prisma.financialIncident.updateMany({
      where: { assetId, status: { not: "RESOLVED" } },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        operatorId: "acceptance-test-isolation",
        operatorEvidence: { note: "closed between independent scenarios" },
      },
    });
    await prisma.asset.update({ where: { id: assetId }, data: { status: "ACTIVE" } });
  });

  let counter = 0;
  function makeIntent(amountWei: bigint): WithdrawalIntent {
    counter += 1;
    return {
      intentId: `wd_accept_${Date.now()}_${counter}`,
      principalId: alice.principalId,
      assetId,
      destination: getAccount(20 + counter).address.toLowerCase() as Address,
      amountAtomic: bigIntToAtomicAmount(amountWei),
      nonce: counter,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId: CHAIN_A_ID,
    };
  }

  function baseOptions() {
    return {
      prisma,
      databaseUrl,
      chainId: CHAIN_A_ID,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      tokenAddress: token.address,
      treasuryAddress: TREASURY,
      treasuryPrivateKey: TREASURY_KEY,
      confirmations: 1,
      deepFinality: 3,
      quorumThreshold: 2,
    } as const;
  }

  async function signedIntent(intent: WithdrawalIntent) {
    const domain = buildWithdrawalDomain(CHAIN_A_ID, TREASURY);
    const signature = await signWithdrawalIntent(intent, domain, getAccount(ALICE_INDEX));
    const recovered = await recoverWithdrawalSigner(intent, domain, signature);
    expect(recovered.toLowerCase()).toBe(ALICE_ADDRESS);
    return signature;
  }

  async function reserveViaApi(intent: WithdrawalIntent): Promise<string> {
    const app = await bootFinanceApi();
    const signature = await signedIntent(intent);
    const response = await submitWithdrawalIntent(app, alice, { intent, signature });
    expect(response.status).toBeLessThan(300);
    expect((response.body as { status: string }).status).toBe("RESERVED");
    const record = await prisma.withdrawalIntentRecord.findUnique({
      where: { id: intent.intentId },
    });
    expect(record?.state).toBe("RESERVED");
    expect(record?.reservedJournalId).toBeTruthy();
    return record!.id;
  }

  it("reserves via the public API, persists exact bytes before broadcast, finalizes and restarts from PostgreSQL", async () => {
    const amount = parseUnits("5", 6);
    const intent = makeIntent(amount);
    await reserveViaApi(intent);

    const reserveAccount = await prisma.atomicAccount.findFirst({
      where: { assetId, ownerId: alice.principalId, class: "PENDING_WITHDRAWAL" },
    });
    expect(reserveAccount?.balanceAtomic).toBe(amount.toString());

    const realBroadcaster = new ViemTreasuryBroadcaster();
    const spy = { broadcasts: 0, persistedBeforeBroadcast: false };
    const harness = buildCustodyHarness({
      ...baseOptions(),
      broadcaster: {
        async broadcast(asset, rawTransaction) {
          spy.broadcasts += 1;
          const persisted = await prisma.withdrawalIntentRecord.findUnique({
            where: { id: intent.intentId },
          });
          spy.persistedBeforeBroadcast =
            persisted?.signedRawTx === rawTransaction && persisted?.txHash !== null;
          return realBroadcaster.broadcast(asset, rawTransaction);
        },
      },
    });
    const worker = new CustodyWorker(
      harness.workflow,
      harness.assets,
      {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      { intervalMs: 1000, reconcileIntervalMs: 60_000 }
    );
    const pickup = await worker.tick();
    expect(pickup.signed).toBe(1);
    expect(pickup.broadcast).toBe(1);
    expect(spy.persistedBeforeBroadcast).toBe(true);
    expect(spy.broadcasts).toBe(1);

    const record = await harness.store.get(intent.intentId);
    expect(record?.signedRawTx).toBeTruthy();
    expect(record?.txHash).toBe(keccak256(record!.signedRawTx!));
    expect(record?.treasuryNonce).not.toBeNull();
    console.log("[finance-acceptance] withdrawal persisted-bytes evidence", {
      intentId: intent.intentId,
      txHash: record!.txHash,
      keccakOfPersistedRawTx: keccak256(record!.signedRawTx!),
      treasuryNonce: record!.treasuryNonce,
      persistedBeforeBroadcast: spy.persistedBeforeBroadcast,
    });

    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash: record!.txHash! });
    const [log] = findTransferLogs(receipt, token.address, {
      to: intent.destination,
      value: amount,
    });
    expect(log).toBeDefined();
    expect(await readTokenBalance(chain, token.address, intent.destination)).toBe(amount);

    await mine(chain, 1);
    await settle();
    const confirmed = await harness.workflow.processIntent(intent.intentId);
    expect(confirmed.action).toBe("confirmed");

    const completed = await harness.store.get(intent.intentId);
    expect(completed?.confirmedJournalId).toBeTruthy();
    const postings = await prisma.journalPosting.findMany({
      where: { transactionId: completed!.confirmedJournalId! },
      include: { account: true },
    });
    const byClass = new Map(postings.map((p) => [p.account.class, p.amountAtomic]));
    expect(byClass.get("PENDING_WITHDRAWAL")).toBe(`-${amount.toString()}`);
    expect(byClass.get("TREASURY_RESERVE")).toBe(amount.toString());

    await mine(chain, 4);
    await settle();
    const finalized = await harness.workflow.processIntent(intent.intentId);
    expect(["finalized", "none"]).toContain(finalized.action);

    // True restart: an entirely new store/workflow reads only PostgreSQL.
    const restarted = buildCustodyHarness(baseOptions());
    const restartedRecord = await restarted.store.get(intent.intentId);
    expect(restartedRecord?.state).toBe("FINALIZED");
    expect(restartedRecord?.signedRawTx).toBe(record?.signedRawTx);
    expect(restartedRecord?.txHash).toBe(record?.txHash);
    const restartedProcess = await restarted.workflow.processIntent(intent.intentId);
    expect(restartedProcess.state).toBe("FINALIZED");
  });

  it("recovers an accepted-but-dropped broadcast from exact persisted bytes after restart with no duplicate transfer", async () => {
    const amount = parseUnits("7", 6);
    const intent = makeIntent(amount);
    await reserveViaApi(intent);

    const flaky = buildCustodyHarness({
      ...baseOptions(),
      broadcaster: acceptedButDroppedBroadcaster(),
    });
    await chain.testClient.setAutomine(false);
    try {
      const ambiguous = await flaky.workflow.processIntent(intent.intentId);
      expect(ambiguous.action).toBe("ambiguous");
      expect(ambiguous.state).toBe("AMBIGUOUS");

      const persisted = await flaky.store.get(intent.intentId);
      const exactBytes = persisted!.signedRawTx!;
      const expectedHash = keccak256(exactBytes);
      expect(persisted!.txHash).toBe(expectedHash);

      const accepted = await chain.publicClient.getTransaction({ hash: expectedHash });
      expect(accepted.nonce).toBe(persisted!.treasuryNonce);
      expect(accepted.blockHash).toBeNull();
      const pendingNonce = await chain.publicClient.getTransactionCount({
        address: TREASURY,
        blockTag: "pending",
      });

      // Restart over the SAME PostgreSQL with a healthy RPC/broadcaster.
      const retries: string[] = [];
      const real = new ViemTreasuryBroadcaster();
      const restarted = buildCustodyHarness({
        ...baseOptions(),
        broadcaster: {
          async broadcast(asset, raw) {
            retries.push(raw);
            return real.broadcast(asset, raw);
          },
        },
      });
      const recovered = await restarted.workflow.processIntent(intent.intentId);
      // Anvil rejects a second submission of an already-known pending tx. That
      // remains ambiguous until inclusion; the retry must still use exact bytes.
      expect(recovered.action).toBe("ambiguous");
      expect(recovered.state).toBe("AMBIGUOUS");
      expect(retries).toEqual([exactBytes]);
      expect(
        await chain.publicClient.getTransactionCount({ address: TREASURY, blockTag: "pending" })
      ).toBe(pendingNonce);

      const after = await restarted.store.get(intent.intentId);
      expect(after?.signedRawTx).toBe(exactBytes);
      expect(after?.txHash).toBe(expectedHash);
      expect(after?.treasuryNonce).toBe(persisted?.treasuryNonce);
      await chain.testClient.setAutomine(true);
      await mine(chain, 1);
      const receipt = await chain.publicClient.waitForTransactionReceipt({ hash: expectedHash });
      expect(
        findTransferLogs(receipt, token.address, { to: intent.destination, value: amount })
      ).toHaveLength(1);
      expect(await readTokenBalance(chain, token.address, intent.destination)).toBe(amount);
    } finally {
      await chain.testClient.setAutomine(true);
    }
  });

  it("blocks signing on native-gas starvation, preserves the obligation, then signs after replenish", async () => {
    const amount = parseUnits("3", 6);
    const intent = makeIntent(amount);
    await reserveViaApi(intent);

    const originalMin = await prisma.asset.findUnique({ where: { id: assetId } });
    await prisma.asset.update({
      where: { id: assetId },
      data: { minGasAtomic: parseEther("1").toString() },
    });
    const original = await getNativeBalance(chain, TREASURY as Address);
    const pendingBefore = await prisma.atomicAccount.findFirst({
      where: { assetId, ownerId: alice.principalId, class: "PENDING_WITHDRAWAL" },
    });
    try {
      await setNativeBalance(chain, TREASURY, 0n);
      const harness = buildCustodyHarness(baseOptions());
      const blocked = await harness.workflow.processIntent(intent.intentId);
      expect(blocked.action).toBe("blocked_gas");
      expect(blocked.state).toBe("BLOCKED_GAS");

      const starvedRecord = await harness.store.get(intent.intentId);
      expect(starvedRecord?.signedRawTx).toBeNull();
      const incidents = await harness.incidents.listOpen({ kind: "GAS_STARVATION" });
      expect(incidents.length).toBeGreaterThanOrEqual(1);

      const pending = await prisma.atomicAccount.findFirst({
        where: { assetId, ownerId: alice.principalId, class: "PENDING_WITHDRAWAL" },
      });
      // The reservation already holds the exact amount; a blocked signing must
      // not change the obligation at all.
      expect(pending?.balanceAtomic).toBe(pendingBefore?.balanceAtomic ?? "0");

      await setNativeBalance(chain, TREASURY, original);
      const recovered = await harness.workflow.processIntent(intent.intentId);
      expect(recovered.action).toBe("signed_broadcast");
      expect(recovered.state).toBe("BROADCAST");

      const receipt = await chain.publicClient.waitForTransactionReceipt({
        hash: recovered.txHash!,
      });
      expect(
        findTransferLogs(receipt, token.address, { to: intent.destination, value: amount })
      ).toHaveLength(1);
    } finally {
      await setNativeBalance(chain, TREASURY, original);
      await prisma.asset.update({
        where: { id: assetId },
        data: { minGasAtomic: originalMin?.minGasAtomic ?? "0" },
      });
    }
  });

  it("allocates distinct treasury nonces concurrently through independent PostgreSQL stores", async () => {
    const intents = [makeIntent(1_000_000n), makeIntent(1_000_000n)];
    for (const intent of intents) await reserveViaApi(intent);
    const workers = intents.map(() => buildCustodyHarness(baseOptions()));
    const outcomes = await Promise.all(
      workers.map((worker, index) => worker.workflow.processIntent(intents[index].intentId))
    );
    expect(outcomes.map((outcome) => outcome.action)).toEqual([
      "signed_broadcast",
      "signed_broadcast",
    ]);
    const records = await Promise.all(
      intents.map((intent) =>
        prisma.withdrawalIntentRecord.findUniqueOrThrow({ where: { id: intent.intentId } })
      )
    );
    const nonces = records
      .map((record) => Number(record.broadcastNonce))
      .sort((left, right) => left - right);
    expect(nonces[1]).toBe(nonces[0] + 1);
    expect(new Set(records.map((record) => record.txHash)).size).toBe(2);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      expect(keccak256(record.signedRawTx as `0x${string}`)).toBe(record.txHash);
      const transaction = await chain.publicClient.getTransaction({
        hash: record.txHash as `0x${string}`,
      });
      expect(transaction.nonce).toBe(Number(record.broadcastNonce));
      const receipt = await chain.publicClient.waitForTransactionReceipt({
        hash: record.txHash as `0x${string}`,
      });
      expect(
        findTransferLogs(receipt, token.address, {
          to: intents[index].destination,
          value: 1_000_000n,
        })
      ).toHaveLength(1);
      expect(await readTokenBalance(chain, token.address, intents[index].destination)).toBe(
        1_000_000n
      );
    }
  });

  it("records a WITHDRAWAL_REORG obligation when a confirmed withdrawal receipt genuinely disappears", async () => {
    const amount = parseUnits("2", 6);
    const intent = makeIntent(amount);
    await reserveViaApi(intent);

    const harness = buildCustodyHarness(baseOptions());

    const snap = await snapshot(chain);
    const broadcast = await harness.workflow.processIntent(intent.intentId);
    expect(broadcast.action).toBe("signed_broadcast");

    await mine(chain, 1);
    await settle();
    const confirmed = await harness.workflow.processIntent(intent.intentId);
    expect(["pending_confirmation", "confirmed"]).toContain(confirmed.action);
    await settle();
    const after = await harness.workflow.processIntent(intent.intentId);
    expect(["confirmed", "finalized"]).toContain(after.action);
    expect(await readTokenBalance(chain, token.address, intent.destination)).toBe(amount);

    const persisted = await harness.store.get(intent.intentId);
    expect(persisted?.confirmedJournalId).toBeTruthy();
    const priorBlockHash = persisted!.receiptBlockHash;
    expect(priorBlockHash).not.toBeNull();
    await mine(chain, 3);
    await settle();
    expect((await harness.workflow.processIntent(intent.intentId)).action).toBe("finalized");
    expect((await harness.store.get(intent.intentId))?.state).toBe("FINALIZED");

    // Genuine missing receipt: revert the inclusion block and do NOT rebroadcast.
    await revertSnapshot(chain, snap);
    await mine(chain, 1);
    await settle();

    // The production scanning pass monitors finalized withdrawals too; direct
    // processIntent is intentionally a no-op for a terminal finalized record.
    const reorged = await harness.workflow.runOnce();
    expect(reorged.reorged).toBe(1);
    expect((await harness.store.get(intent.intentId))?.state).toBe("REORGED");

    const incident = await harness.incidents.listOpen({ kind: "WITHDRAWAL_REORG" });
    expect(incident.length).toBe(1);

    const reorgRecord = await harness.store.get(intent.intentId);
    expect(reorgRecord?.reorgJournalId).toBeTruthy();
    const postings = await prisma.journalPosting.findMany({
      where: { transactionId: reorgRecord!.reorgJournalId! },
      include: { account: true },
    });
    const byClass = new Map(postings.map((p) => [p.account.class, p.amountAtomic]));
    expect(byClass.get("INCIDENT_OBLIGATION")).toBe(amount.toString());
    expect(byClass.get("TREASURY_RESERVE")).toBe(`-${amount.toString()}`);
    const journalCount = await prisma.journalTransaction.count({ where: { assetId } });
    const restarted = buildCustodyHarness(baseOptions());
    const retried = await restarted.workflow.processIntent(intent.intentId);
    expect(retried.action).toBe("rebroadcast");
    expect((await harness.store.get(intent.intentId))?.state).toBe("REORGED");
    expect(await prisma.journalTransaction.count({ where: { assetId } })).toBe(journalCount);
    expect((await harness.store.get(intent.intentId))?.reorgJournalId).toBe(
      reorgRecord?.reorgJournalId
    );

    const assetState = await harness.assets.get(assetId);
    expect(assetState?.status).toBe("FROZEN");
  });
});
