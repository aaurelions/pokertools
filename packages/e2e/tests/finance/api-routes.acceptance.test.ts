/**
 * Finance HTTP route contract acceptance against the REAL Fastify app on a
 * fresh PostgreSQL/Redis pair and a real Anvil chain.
 *
 * Authentication is a real public SIWE session (`/auth/nonce` + `/auth/login`).
 * Effective finance routes are mounted under `/finance`:
 *   GET  /finance/assets
 *   GET  /finance/balances
 *   POST /finance/deposits/claim
 *   GET  /finance/deposits/:id
 *   POST /finance/withdrawals/intents
 *   GET  /finance/withdrawals/:id
 *
 * Funding is never seeded in the database: the credited balance comes from a
 * real on-chain direct-treasury deposit claim.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  AssetSchema,
  BalanceSchema,
  DepositClaimSchema,
  bigIntToAtomicAmount,
  type Asset,
  type WithdrawalIntent,
} from "@pokertools/types";
import { parseUnits, type Address } from "viem";
import {
  attachTwoChainAnvil,
  CHAIN_A_ID,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  mine,
  mintToken,
  transferToken,
  type DeployedToken,
  type LocalChain,
} from "./helpers/anvil-two-chain.js";
import { startQuorumProxies, type ProxySet } from "./helpers/quorum-proxy.js";
import { requireInfra } from "./helpers/infra.js";
import { createAssetFixture, resolveAllOpenIncidents } from "./helpers/finance-fixtures.js";
import {
  apiRequest,
  bootFinanceApi,
  claimDeposit,
  closeFinanceApi,
  configureFinanceApiEnv,
  getAssets,
  getBalances,
  getDeposit,
  getWithdrawal,
  siweLogin,
  submitWithdrawalIntent,
  type WalletAuth,
} from "./helpers/finance-api-harness.js";
import { buildWithdrawalDomain, signWithdrawalIntent } from "./helpers/eip712.js";

const TREASURY_INDEX = 0;
const ALICE_INDEX = 11;
const TREASURY = getAccount(TREASURY_INDEX).address.toLowerCase() as Address;
const ALICE_ADDRESS = getAccount(ALICE_INDEX).address.toLowerCase();

describe("finance route contract acceptance", () => {
  let app: FastifyInstance;
  let chain: LocalChain;
  let token: DeployedToken;
  let proxies: ProxySet;
  let asset: Asset;
  let alice: WalletAuth;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 4_300));

  beforeAll(async () => {
    const infra = requireInfra();
    configureFinanceApiEnv({ databaseUrl: infra.databaseUrl, redisUrl: infra.redisUrl });
    ({ chainA: chain } = await attachTwoChainAnvil());
    token = await deployMockUsdc6(chain);
    proxies = await startQuorumProxies(chain.rpcUrl, 2);
    app = await bootFinanceApi(infra);
    await resolveAllOpenIncidents(app.prisma);
    alice = await siweLogin(app, getAccount(ALICE_INDEX));

    asset = AssetSchema.parse({
      assetId: `eip155:${CHAIN_A_ID}/erc20:${token.address.toLowerCase()}`,
      chainId: CHAIN_A_ID,
      tokenAddress: token.address.toLowerCase(),
      decimals: 6,
      symbol: token.symbol,
      status: "ACTIVE",
      confirmations: 1,
      deepFinality: 2,
    });
    await createAssetFixture(app.prisma, {
      assetId: asset.assetId,
      chainId: CHAIN_A_ID,
      tokenAddress: token.address,
      symbol: token.symbol,
      decimals: 6,
      treasuryAddress: TREASURY,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      confirmations: 1,
      deepFinality: 2,
    });

    // Real funded balance: Alice sends tokens to the treasury and claims them.
    const amount = parseUnits("20", 6);
    await mintToken(chain, token.address, ALICE_ADDRESS as Address, amount);
    const receipt = await transferToken(chain, token.address, ALICE_INDEX, TREASURY, amount);
    const [log] = findTransferLogs(receipt, token.address, { from: ALICE_ADDRESS, to: TREASURY });
    await mine(chain, 1);
    await settle();
    const claim = await claimDeposit(app, alice, {
      assetId: asset.assetId,
      txHash: log.txHash,
      logIndex: log.logIndex,
    });
    expect(claim.status).toBeLessThan(300);
  });

  afterAll(async () => {
    await app.prisma.asset
      .update({ where: { id: asset.assetId }, data: { status: "FROZEN" } })
      .catch(() => undefined);
    await resolveAllOpenIncidents(app.prisma);
    await closeFinanceApi();
    await proxies?.close();
  });

  it("requires authentication on every private finance route", async () => {
    for (const request of [
      { method: "GET" as const, url: "/finance/balances" },
      { method: "POST" as const, url: "/finance/deposits/claim", payload: {} },
      { method: "GET" as const, url: "/finance/deposits/none" },
      { method: "POST" as const, url: "/finance/withdrawals/intents", payload: {} },
      { method: "GET" as const, url: "/finance/withdrawals/none" },
    ]) {
      const response = await apiRequest(app, request);
      expect(response.status).toBe(401);
    }
  });

  it("serves the public asset registry without a session", async () => {
    const response = await apiRequest(app, { method: "GET", url: "/finance/assets" });
    expect(response.status).toBe(200);
  });

  it("GET /finance/assets returns canonical Asset records", async () => {
    const response = await getAssets(app, alice);
    expect(response.status).toBe(200);
    const body = response.body as { assets: unknown[] };
    const found = (body.assets as Asset[]).find((entry) => entry.assetId === asset.assetId);
    expect(found).toBeDefined();
    expect(AssetSchema.parse(found)).toMatchObject({
      assetId: asset.assetId,
      chainId: CHAIN_A_ID,
      decimals: 6,
    });
  });

  it("GET /finance/balances returns canonical Balance records", async () => {
    const response = await getBalances(app, alice);
    expect(response.status).toBe(200);
    const list = (response.body as { balances: unknown[] }).balances;
    const entry = list.find(
      (candidate) => (candidate as { assetId: string }).assetId === asset.assetId
    );
    expect(entry).toBeDefined();
    const parsed = BalanceSchema.parse(entry);
    expect(parsed.principalId).toBe(alice.principalId);
    expect(parsed.availableAtomic).toBe(parseUnits("20", 6).toString());
  });

  it("POST /finance/deposits/claim + GET /finance/deposits/:id return a canonical claim", async () => {
    const amount = parseUnits("11", 6);
    await mintToken(chain, token.address, ALICE_ADDRESS as Address, amount);
    const receipt = await transferToken(chain, token.address, ALICE_INDEX, TREASURY, amount);
    const [log] = findTransferLogs(receipt, token.address, { from: ALICE_ADDRESS, to: TREASURY });
    await mine(chain, 1);
    await settle();

    const claim = await claimDeposit(app, alice, {
      assetId: asset.assetId,
      txHash: log.txHash,
      logIndex: log.logIndex,
    });
    expect(claim.status).toBeLessThan(300);
    const parsedClaim = DepositClaimSchema.parse(claim.body);
    expect(parsedClaim).toMatchObject({
      assetId: asset.assetId,
      txHash: log.txHash,
      logIndex: log.logIndex,
      principalId: alice.principalId,
      amountAtomic: bigIntToAtomicAmount(amount),
      status: "CREDITED",
    });

    const stored = await getDeposit(app, alice, parsedClaim.id);
    expect(stored.status).toBe(200);
    const parsedStored = DepositClaimSchema.parse(stored.body);
    expect(parsedStored.id).toBe(parsedClaim.id);
    expect(parsedStored.amountAtomic).toBe(bigIntToAtomicAmount(amount));
  });

  it("POST /finance/withdrawals/intents accepts a canonical EIP-712 submission, reserves funds and persists it", async () => {
    const amount = parseUnits("4", 6);
    const intent: WithdrawalIntent = {
      intentId: `route_wd_${Date.now()}`,
      principalId: alice.principalId,
      assetId: asset.assetId,
      destination: getAccount(42).address.toLowerCase() as Address,
      amountAtomic: bigIntToAtomicAmount(amount),
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId: CHAIN_A_ID,
    };
    const domain = buildWithdrawalDomain(CHAIN_A_ID, TREASURY);
    const signature = await signWithdrawalIntent(intent, domain, getAccount(ALICE_INDEX));

    const response = await submitWithdrawalIntent(app, alice, { intent, signature });
    expect(response.status).toBeLessThan(300);
    expect((response.body as { status: string }).status).toBe("RESERVED");

    const stored = await getWithdrawal(app, alice, intent.intentId);
    expect(stored.status).toBe(200);
    const record = stored.body as {
      intentId: string;
      principalId: string;
      assetId: string;
      chainId: number;
      status: string;
      destination: string;
      amountAtomic: string;
    };
    expect(record).toMatchObject({
      intentId: intent.intentId,
      principalId: alice.principalId,
      assetId: asset.assetId,
      chainId: CHAIN_A_ID,
      destination: intent.destination,
      amountAtomic: intent.amountAtomic,
      status: "RESERVED",
    });

    // Reservation must hold the exact amount in PENDING_WITHDRAWAL.
    const balances = await getBalances(app, alice);
    const entry = (
      balances.body as { balances: Array<{ assetId: string; pendingWithdrawalAtomic: string }> }
    ).balances.find((candidate) => candidate.assetId === asset.assetId);
    expect(entry?.pendingWithdrawalAtomic).toBe(amount.toString());
  });

  it("POST /finance/withdrawals/intents rejects a bad signature", async () => {
    const intent: WithdrawalIntent = {
      intentId: `route_wd_bad_${Date.now()}`,
      principalId: alice.principalId,
      assetId: asset.assetId,
      destination: getAccount(43).address.toLowerCase() as Address,
      amountAtomic: bigIntToAtomicAmount(parseUnits("1", 6)),
      nonce: 2,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId: CHAIN_A_ID,
    };
    const response = await submitWithdrawalIntent(app, alice, {
      intent,
      signature: `0x${"11".repeat(65)}`,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 404 for unknown deposit and withdrawal ids", async () => {
    expect((await getDeposit(app, alice, "does-not-exist")).status).toBe(404);
    expect((await getWithdrawal(app, alice, "does-not-exist")).status).toBe(404);
  });
});
