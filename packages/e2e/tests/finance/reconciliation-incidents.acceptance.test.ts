/**
 * Treasury reconciliation + durable incident acceptance against the REAL
 * custody workflow reconciliation path (`WithdrawalWorkflow.reconcileAsset`),
 * REAL PostgreSQL stores/ledger and a REAL operator resolution through the
 * public `/finance/incidents/:id/resolve` route.
 *
 * The on-chain treasury balance is compared to the signed ledger-expected
 * atomics: a real shortfall opens a durable TREASURY_SHORTFALL incident and
 * freezes the asset; restoring real backing records a fresh MATCHED
 * reconciliation and the operator can resolve the incident through the public
 * API health rechecks. Quorum unavailability fails closed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { parseUnits } from "viem";
import { AtomicLedger } from "../../../api/src/finance-core.js";
import { buildCustodyHarness, type CustodyHarness } from "./helpers/custody-harness.js";
import { ViemQuorumReader } from "../../../custody/src/core/viem-ports.js";
import type { TreasuryAsset } from "../../../custody/src/core/types.js";
import {
  attachTwoChainAnvil,
  CHAIN_A_ID,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  mine,
  mintToken,
  revertSnapshot,
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
  bootstrapOperator,
  bootFinanceApi,
  claimDeposit,
  closeFinanceApi,
  configureFinanceApiEnv,
  resolveIncident,
  siweLogin,
  type WalletAuth,
} from "./helpers/finance-api-harness.js";

const TREASURY_INDEX = 0;
const ALICE_INDEX = 11;
const TREASURY = getAccount(TREASURY_INDEX).address.toLowerCase() as Address;
const ALICE_ADDRESS = getAccount(ALICE_INDEX).address.toLowerCase();

describe("treasury reconciliation incident acceptance (real Prisma custody + API)", () => {
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
      minGasAtomic: "0",
    });

    // Real backing exactly equal to the ledger liability: Alice deposits 50 and
    // the treasury receives those 50 on-chain. No arbitrary treasury prefund, so
    // reconciliation compares real custody to the real ledger.
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
  });

  afterAll(async () => {
    await prisma.asset
      .update({ where: { id: assetId }, data: { status: "FROZEN" } })
      .catch(() => undefined);
    await resolveAllOpenIncidents(prisma);
    await closeFinanceApi();
    await proxies?.close();
    await prisma?.$disconnect();
  });

  /** Close incidents between independent reconciliation scenarios. */
  afterEach(async () => {
    await resolveAllOpenIncidents(prisma);
    await prisma.asset.update({ where: { id: assetId }, data: { status: "ACTIVE" } });
  });

  function baseOptions() {
    return {
      prisma,
      databaseUrl,
      chainId: CHAIN_A_ID,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      tokenAddress: token.address,
      treasuryAddress: TREASURY,
      treasuryPrivateKey:
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
      confirmations: 1,
      deepFinality: 3,
      quorumThreshold: 1,
      minQuorum: 1,
    } as const;
  }

  function harness(
    overrides: Partial<Parameters<typeof buildCustodyHarness>[0]> = {}
  ): CustodyHarness {
    return buildCustodyHarness({ ...baseOptions(), ...overrides });
  }

  it("opens a durable TREASURY_SHORTFALL incident on a real on-chain shortfall", async () => {
    const h = harness();
    const snap = await snapshot(chain);
    try {
      const stranger = getAccount(60).address;
      await transferToken(chain, token.address, TREASURY_INDEX, stranger, parseUnits("20", 6));

      const outcome = await h.workflow.reconcileAsset(assetId);
      expect(outcome.mismatch).toBe(true);
      expect(outcome.custodyAtomic).toBe(parseUnits("30", 6).toString());
      expect(outcome.expectedAtomic).toBe(parseUnits("50", 6).toString());
      expect(outcome.incident).not.toBeNull();

      const open = await h.incidents.listOpen({ kind: "TREASURY_SHORTFALL" });
      expect(open.length).toBeGreaterThanOrEqual(1);
      expect(open[0].detail).toMatchObject({ treasuryAddress: TREASURY });

      const assetState = await h.assets.get(assetId);
      expect(assetState?.status).toBe("FROZEN");
    } finally {
      await revertSnapshot(chain, snap);
    }
  });

  it("records a matched reconciliation after real backing is restored and resolves through the operator API", async () => {
    const app = await bootFinanceApi();
    const operator = await bootstrapOperator(app, getAccount(70));
    const h = harness();
    const snap = await snapshot(chain);
    try {
      const stranger = getAccount(8);
      await transferToken(
        chain,
        token.address,
        TREASURY_INDEX,
        stranger.address,
        parseUnits("10", 6)
      );
      const shortfall = await h.workflow.reconcileAsset(assetId);
      expect(shortfall.mismatch).toBe(true);
      expect(shortfall.incident).not.toBeNull();

      // Restore real backing so on-chain custody matches ledger-expected again.
      await transferToken(chain, token.address, 8, TREASURY, parseUnits("10", 6));
      const balanced = await h.workflow.reconcileAsset(assetId);
      expect(balanced.mismatch).toBe(false);
      expect(balanced.incident).toBeNull();

      const reconciliation = await prisma.treasuryReconciliation.findFirst({
        where: { assetId },
        orderBy: { createdAt: "desc" },
      });
      expect(reconciliation?.status).toBe("MATCHED");
      expect(reconciliation?.differenceAtomic).toBe("0");

      // The route reads an injected readiness re-check; wire a real one that
      // enforces the ledger invariant and a live native-gas quorum.
      const ledger = new AtomicLedger(prisma);
      const treasuryAsset: TreasuryAsset = {
        assetId,
        chainId: CHAIN_A_ID,
        tokenAddress: token.address,
        treasuryAddress: TREASURY,
        rpcUrls: proxies.proxies.map((proxy) => proxy.url),
        minGasAtomic: "0",
        confirmations: 1,
        deepFinality: 3,
        status: "ACTIVE",
      };
      (app as unknown as { financialReadinessCheck?: unknown }).financialReadinessCheck = async (
        tx: never,
        incident: { assetId: string | null }
      ) => {
        if (incident.assetId) await ledger.assertAssetBalanced(tx as never, incident.assetId);
        const reader = new ViemQuorumReader({ threshold: 2, retryCount: 0 });
        const balance = await reader.nativeBalance(treasuryAsset, TREASURY);
        if (!balance.agreed || (balance.value ?? 0n) < BigInt(treasuryAsset.minGasAtomic)) {
          throw new Error("native gas readiness check failed");
        }
      };

      const resolved = await resolveIncident(app, operator, shortfall.incident!.incidentId, {
        note: "backing restored and independently verified",
        observedAtomic: balanced.custodyAtomic,
        expectedAtomic: balanced.expectedAtomic,
      });
      expect(resolved.status).toBeLessThan(300);
      expect((resolved.body as { status: string }).status).toBe("RESOLVED");

      const closed = await prisma.financialIncident.findUnique({
        where: { id: shortfall.incident!.incidentId },
      });
      expect(closed?.status).toBe("RESOLVED");
      expect(closed?.operatorId).toBe(operator.principalId);

      const assetRow = await prisma.asset.findUnique({ where: { id: assetId } });
      expect(assetRow?.status).toBe("ACTIVE");
    } finally {
      await revertSnapshot(chain, snap);
    }
  });

  it("fails closed with an RPC disagreement incident when custody quorum is unavailable", async () => {
    const real = new ViemQuorumReader({ threshold: 2, retryCount: 0 });
    const disagreeing = {
      ...real,
      async erc20BalanceOf(asset: TreasuryAsset, owner: string) {
        const result = await real.erc20BalanceOf(asset, owner);
        return { ...result, agreed: false, value: null };
      },
    };
    const h = harness({ quorum: disagreeing as never });

    await expect(h.workflow.reconcileAsset(assetId)).rejects.toThrow(/quorum/i);
    const open = await h.incidents.listOpen({ kind: "RPC_DISAGREEMENT" });
    expect(open.length).toBeGreaterThanOrEqual(1);
  });
});
