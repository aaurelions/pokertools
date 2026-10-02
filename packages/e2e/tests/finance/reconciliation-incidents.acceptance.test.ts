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
import { buildCustodyHarness, type CustodyHarness } from "./helpers/custody-harness.js";
import {
  attachTwoChainAnvil,
  CHAIN_A_ID,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  getNativeBalance,
  mine,
  mintToken,
  revertSnapshot,
  snapshot,
  setNativeBalance,
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
      quorumThreshold: 2,
      minQuorum: 2,
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
      expect(reconciliation?.blockNumber).not.toBeNull();
      const canonical = await chain.publicClient.getBlock({
        blockNumber: BigInt(reconciliation!.blockNumber!),
      });
      expect((reconciliation?.evidence as { blockHash: string }).blockHash).toBe(canonical.hash);

      // A recently MATCHED row must not authorize unfreeze after backing changes.
      await transferToken(
        chain,
        token.address,
        TREASURY_INDEX,
        stranger.address,
        parseUnits("1", 6)
      );
      const denied = await resolveIncident(app, operator, shortfall.incident!.incidentId, {
        note: "recent evidence is not live backing",
      });
      expect(denied.status).toBe(503);
      expect((denied.body as { code: string }).code).toBe("RECONCILIATION_UNVERIFIED");
      expect(
        (
          await prisma.financialIncident.findUnique({
            where: { id: shortfall.incident!.incidentId },
          })
        )?.status
      ).toBe("OPEN");
      expect((await prisma.asset.findUnique({ where: { id: assetId } }))?.status).toBe("FROZEN");
      await transferToken(chain, token.address, 8, TREASURY, parseUnits("1", 6));
      const nativeGas = await getNativeBalance(chain, TREASURY);
      await prisma.asset.update({ where: { id: assetId }, data: { minGasAtomic: "1" } });
      try {
        await setNativeBalance(chain, TREASURY, 0n);
        const gasDenied = await resolveIncident(app, operator, shortfall.incident!.incidentId, {
          note: "real gas starvation",
        });
        expect(gasDenied.status, gasDenied.raw).toBe(503);
        expect((gasDenied.body as { code: string }).code).toBe("NATIVE_GAS_UNVERIFIED");
        expect(
          (
            await prisma.financialIncident.findUniqueOrThrow({
              where: { id: shortfall.incident!.incidentId },
            })
          ).status
        ).toBe("OPEN");
      } finally {
        await setNativeBalance(chain, TREASURY, nativeGas);
      }

      const beforeResolution = await prisma.financialIncident.findUniqueOrThrow({
        where: { id: shortfall.incident!.incidentId },
      });
      const resolutions = await Promise.all(
        ["resolver-a", "resolver-b"].map((note) =>
          resolveIncident(app, operator, shortfall.incident!.incidentId, {
            note,
            observedAtomic: balanced.custodyAtomic,
            expectedAtomic: balanced.expectedAtomic,
          })
        )
      );
      expect(resolutions.map((response) => response.status).sort()).toEqual([200, 409]);
      const resolved = resolutions.find((response) => response.status === 200)!;
      expect((resolved.body as { status: string }).status).toBe("RESOLVED");

      const closed = await prisma.financialIncident.findUnique({
        where: { id: shortfall.incident!.incidentId },
      });
      expect(closed?.status).toBe("RESOLVED");
      expect(closed?.operatorId).toBe(operator.principalId);
      expect(closed?.version).toBe(beforeResolution.version + 1);

      const assetRow = await prisma.asset.findUnique({ where: { id: assetId } });
      expect(assetRow?.status).toBe("ACTIVE");
    } finally {
      await revertSnapshot(chain, snap);
    }
  });

  it("fails closed with an RPC disagreement incident when custody quorum is unavailable", async () => {
    const h = harness();
    proxies.proxies[1].state.ethCallResultOverride = `0x${"00".repeat(32)}`;
    try {
      await expect(h.workflow.reconcileAsset(assetId)).rejects.toThrow(/quorum/i);
      const open = await h.incidents.listOpen({ kind: "RPC_DISAGREEMENT" });
      expect(
        open.some((incident) => incident.assetId === assetId || incident.chainId === CHAIN_A_ID)
      ).toBe(true);
      expect((await prisma.asset.findUnique({ where: { id: assetId } }))?.status).toBe("FROZEN");
    } finally {
      proxies.proxies[1].state.ethCallResultOverride = undefined;
    }
    expect((await h.workflow.reconcileAsset(assetId)).mismatch).toBe(false);
    // Observation recovery does not authorize new signing or unfreeze a route.
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: assetId } })).status).toBe(
      "FROZEN"
    );
  });
});
