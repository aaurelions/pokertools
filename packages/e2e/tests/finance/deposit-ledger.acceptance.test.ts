/**
 * Durable deposit-claim acceptance: exact-log verification -> balanced atomic
 * ledger credit -> idempotent duplicate, against the REAL
 * `CanonicalDepositService`, the REAL `createCanonicalDepositVerifier` and a
 * fresh PostgreSQL database.
 *
 * A real ChainRegistry-backed verifier over two independent quorum proxies is
 * injected through the service constructor. The chain direction is the canonical
 * direct-treasury deposit: the wallet sends the ERC-20 to the asset treasury.
 * No balance is seeded in the database; the only credit under assertion comes
 * from the verified on-chain transfer and its balanced journal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUnits, type Address } from "viem";
import { ChainRegistry } from "../../../api/src/services/chain-registry.js";
import { CanonicalDepositService } from "../../../api/src/services/canonical-deposits.js";
import { createCanonicalDepositVerifier } from "../../../api/src/services/canonical-deposit-verifier.js";
// @ts-ignore - cross-package source import resolved by vitest
import { createPrismaClient } from "../../../api/src/utils/prisma-client.js";
import { createAssetFixture } from "./helpers/finance-fixtures.js";
import { requireInfra } from "./helpers/infra.js";
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

const TREASURY_INDEX = 0;
const ALICE_INDEX = 11;
const TREASURY = getAccount(TREASURY_INDEX).address.toLowerCase();
const ALICE = getAccount(ALICE_INDEX).address.toLowerCase();

describe("durable deposit ledger acceptance (real service + fresh PostgreSQL)", () => {
  let prisma: ReturnType<typeof createPrismaClient>;
  let chain: LocalChain;
  let token: DeployedToken;
  let proxies: ProxySet;
  let registry: ChainRegistry;
  let service: CanonicalDepositService;
  let assetId: string;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 4_300));

  beforeAll(async () => {
    const infra = requireInfra();
    process.env.DATABASE_URL = infra.databaseUrl;
    process.env.NODE_ENV = "test";
    prisma = createPrismaClient();

    ({ chainA: chain } = await attachTwoChainAnvil());
    token = await deployMockUsdc6(chain);
    assetId = `eip155:${CHAIN_A_ID}/erc20:${token.address.toLowerCase()}`;

    proxies = await startQuorumProxies(chain.rpcUrl, 2);
    registry = new ChainRegistry({
      endpoints: proxies.proxies.map((proxy, index) => ({
        id: `a${index}`,
        chainId: CHAIN_A_ID,
        url: proxy.url,
      })),
      quorum: 2,
    });
    await registry.start();

    await createAssetFixture(prisma, {
      assetId,
      chainId: CHAIN_A_ID,
      tokenAddress: token.address as Address,
      symbol: token.symbol,
      decimals: 6,
      treasuryAddress: TREASURY as Address,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      confirmations: 1,
      deepFinality: 3,
    });

    const verifier = createCanonicalDepositVerifier({
      prisma: prisma as never,
      getRegistry: async () => registry,
    });
    service = new CanonicalDepositService(prisma, { verifier });
  });

  afterAll(async () => {
    await prisma.asset
      .update({ where: { id: assetId }, data: { status: "FROZEN" } })
      .catch(() => undefined);
    await proxies?.close();
    await prisma?.$disconnect();
  });

  async function claimableLog(amount: bigint) {
    await mintToken(chain, token.address, ALICE as Address, amount);
    const receipt = await transferToken(
      chain,
      token.address,
      ALICE_INDEX,
      TREASURY as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, token.address, {
      from: ALICE as Address,
      to: TREASURY as Address,
    });
    await mine(chain, 1);
    await settle();
    return log;
  }

  it("credits the real on-chain amount once and is idempotent on duplicate", async () => {
    const amount = parseUnits("25", 6);
    const log = await claimableLog(amount);

    const first = await service.claimDirectTreasury({
      principalId: "principal-alice",
      walletAddress: ALICE,
      assetId,
      txHash: log.txHash,
      logIndex: log.logIndex,
    });
    expect(first.idempotent).toBe(false);
    expect(first.status).toBe("CREDITED");
    expect(first.amountAtomic).toBe(amount.toString());
    expect(first.assetId).toBe(assetId);
    expect(first.provenance).toBe("DIRECT_TREASURY");
    expect(first.creditedJournalId).toBeTruthy();

    const duplicate = await service.claimDirectTreasury({
      principalId: "principal-alice",
      walletAddress: ALICE,
      assetId,
      txHash: log.txHash,
      logIndex: log.logIndex,
    });
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.id).toBe(first.id);

    const account = await prisma.atomicAccount.findFirst({
      where: { assetId, ownerId: "principal-alice", class: "USER_AVAILABLE" },
    });
    expect(account?.balanceAtomic).toBe(amount.toString());

    // Acceptance proof: read the raw sealed journal and verify the exact
    // balanced postings (USER_AVAILABLE +a, TREASURY_RESERVE -a).
    const postings = await prisma.journalPosting.findMany({
      where: { transactionId: first.creditedJournalId! },
      include: { account: true },
      orderBy: { amountAtomic: "asc" },
    });
    expect(postings).toHaveLength(2);
    const byClass = new Map(postings.map((p) => [p.account.class, p.amountAtomic]));
    expect(byClass.get("USER_AVAILABLE")).toBe(amount.toString());
    expect(byClass.get("TREASURY_RESERVE")).toBe(`-${amount.toString()}`);
    const sum = postings.reduce((acc, p) => acc + BigInt(p.amountAtomic), 0n);
    expect(sum).toBe(0n);

    const sealed = await prisma.journalTransaction.findUnique({
      where: { id: first.creditedJournalId! },
    });
    expect(sealed?.sealed).toBe(true);
  });

  it("rejects a claim whose on-chain sender is not the authenticated wallet", async () => {
    const amount = parseUnits("5", 6);
    const strangerIndex = 15;
    const stranger = getAccount(strangerIndex).address;
    await mintToken(chain, token.address, stranger, amount);
    const receipt = await transferToken(
      chain,
      token.address,
      strangerIndex,
      TREASURY as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, token.address, { value: amount });
    await mine(chain, 1);
    await settle();

    await expect(
      service.claimDirectTreasury({
        principalId: "principal-alice",
        walletAddress: ALICE,
        assetId,
        txHash: log.txHash,
        logIndex: log.logIndex,
      })
    ).rejects.toMatchObject({ code: "DEPOSIT_NOT_VERIFIED" });

    const account = await prisma.atomicAccount.findFirst({
      where: { assetId, ownerId: "principal-alice", class: "USER_AVAILABLE" },
    });
    // The successful first test credited 25; the rejected claim added nothing.
    expect(account?.balanceAtomic).toBe(parseUnits("25", 6).toString());
  });

  it("credits distinct exact logs independently and sums the durable balance", async () => {
    const before = await prisma.atomicAccount.findFirst({
      where: { assetId, ownerId: "principal-alice", class: "USER_AVAILABLE" },
    });
    const firstAmount = parseUnits("3", 6);
    const secondAmount = parseUnits("4", 6);
    const firstLog = await claimableLog(firstAmount);
    const secondLog = await claimableLog(secondAmount);

    const first = await service.claimDirectTreasury({
      principalId: "principal-alice",
      walletAddress: ALICE,
      assetId,
      txHash: firstLog.txHash,
      logIndex: firstLog.logIndex,
    });
    const second = await service.claimDirectTreasury({
      principalId: "principal-alice",
      walletAddress: ALICE,
      assetId,
      txHash: secondLog.txHash,
      logIndex: secondLog.logIndex,
    });
    expect(first.id).not.toBe(second.id);
    expect(first.creditedJournalId).not.toBe(second.creditedJournalId);

    const after = await prisma.atomicAccount.findFirst({
      where: { assetId, ownerId: "principal-alice", class: "USER_AVAILABLE" },
    });
    const expected = BigInt(before?.balanceAtomic ?? "0") + firstAmount + secondAmount;
    expect(after?.balanceAtomic).toBe(expected.toString());
    await expect(
      service.claimDirectTreasury({
        principalId: "principal-alice",
        walletAddress: ALICE,
        assetId,
        txHash: firstLog.txHash,
        logIndex: firstLog.logIndex,
      })
    ).resolves.toMatchObject({ idempotent: true, id: first.id });
  });
});
